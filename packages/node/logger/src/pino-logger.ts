import { hostname } from 'node:os';
import { injectable, inject } from 'inversify';
import pino, { Logger, TransportTargetOptions } from 'pino';
import { trace } from '@opentelemetry/api';
import { ILogger } from './i-logger.js';
import type { PinoLoggerConfig } from './pino-logger-schema.js';

/**
 * Fleet-wide PII redaction for structured log fields. Defense-in-depth so a
 * caller that logs `{ email }`, a name, a token, or a whole request `input`/
 * `body`/`payload` doesn't leak it into CloudWatch/Datadog.
 *
 * Limits worth knowing (pino's `redact` is not a catch-all):
 *  - Keys ONLY. It masks structured object fields, never interpolated message
 *    strings — `logger.info(`user ${email}`)` is NOT redacted. Keep PII out of
 *    the message text at the call site.
 *  - Shallow wildcards. `*.email` matches one level; pino has no recursive
 *    `**`, so we enumerate the shapes PII actually arrives in: top-level, one
 *    level deep (`*.`), and under the `err` wrapper that `error()` adds.
 *  - No ancestor/descendant overlap. pino's fast-redact THROWS at construction
 *    on a path that is both covered by a wildcard parent and listed as a child
 *    (e.g. `input` + `input.email`) — and that throw would crash this shared
 *    logger fleet-wide. So request objects are redacted WHOLESALE (`input`,
 *    `payload`, `body`) with no child paths under them — blunt but safe for
 *    unbounded user content.
 *  - `code` is deliberately NOT redacted (tRPC error codes, HTTP status, and
 *    district codes all use it); one-time/auth codes use specific keys
 *    (`otp`, `authCode`).
 */
const REDACT_PATHS = [
  // Email
  'email',
  '*.email',
  'err.email',
  // Names (raw + the normalized variants the student search uses)
  'name',
  '*.name',
  'firstName',
  'lastName',
  'firstNameNorm',
  'lastNameNorm',
  '*.firstNameNorm',
  '*.lastNameNorm',
  // Date of birth (FERPA)
  'dob',
  '*.dob',
  // Secrets / tokens / one-time codes
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'otp',
  'authCode',
  // Unbounded user-content objects — redacted WHOLESALE (no child paths under
  // these, see the overlap note above)
  'input',
  'payload',
  'body',
] as const;

/** Shared so both pino construction paths (prod stdout + transport) redact identically. */
export const redact = { paths: [...REDACT_PATHS], censor: '[REDACTED]' };

/**
 * Merges the active OTel span's trace/span IDs into every log line so
 * Datadog can link a log to its trace. pino calls this on each log call
 * (cheaper than wrapping every public method) and merges the result under
 * the log object. `trace.getActiveSpan()` returns undefined outside a
 * traced context (e.g. startup messages), so those logs are unaffected.
 *
 * OTel's SpanContext.traceId/spanId are already lowercase hex strings
 * (32/16 chars) per the W3C Trace Context spec — the exact format Datadog
 * expects for its `trace_id`/`span_id` log fields, no conversion needed.
 */
export function traceCorrelationMixin(): Record<string, string> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

/**
 * Deployment context for every log line, sourced from the SAME env var the
 * OTel tracer reads (OTEL_RESOURCE_ATTRIBUTES, set per-container by the
 * service templates, e.g. `deployment.environment.name=dev,
 * deployment.identifier=main`). Traces already carry these as resource
 * attributes; mirroring them into the log JSON gives Datadog the matching
 * `@deployment.identifier` / `@deployment.environment.name` log attributes,
 * so one facet filters logs AND traces to a specific sandbox deployment.
 * `version` alone can't do that — one version is often live on several
 * sandboxes at once.
 *
 * Degrade-safe: containers without the env var (or without the deployment.*
 * keys) log exactly as before — no empty placeholder keys are emitted.
 * Values are percent-decoded per the OTel spec (W3C-baggage-style encoding);
 * a value that fails to decode is kept raw rather than dropped.
 *
 * Exported for unit testing.
 */
export function resolveDeploymentBindings(
  raw: string | undefined = process.env.OTEL_RESOURCE_ATTRIBUTES,
): { deployment?: { environment?: { name: string }; identifier?: string } } {
  if (!raw) return {};
  const attrs = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding — treat as a literal value.
    }
    if (key && value) attrs.set(key, value);
  }
  // `deployment.environment` is the pre-1.27 OTel semconv name; templates set
  // both during the transition, newer ones may set only `.name`.
  const name =
    attrs.get('deployment.environment.name') ?? attrs.get('deployment.environment');
  const identifier = attrs.get('deployment.identifier');
  if (!name && !identifier) return {};
  return {
    deployment: {
      ...(name ? { environment: { name } } : {}),
      ...(identifier ? { identifier } : {}),
    },
  };
}

@injectable()
export class PinoLogger implements ILogger {
  private readonly logger: Logger;

  constructor(@inject('PinoLoggerConfig') private config: PinoLoggerConfig) {
    const env = process.env.NODE_ENV || 'development';
    const isForeground = Boolean(process.stdout.isTTY);
    const isExpressContext = config.isExpressContext;
    const logFile = config.logFile;

    // Pretty output requires a real terminal. Deployed dev services (NODE_ENV
    // =development, no TTY) used to hit the fallback below with prettyPrint on
    // and ship ANSI-colored multi-line text to CloudWatch — unparseable by
    // Datadog (no level, no attributes, stack traces split line-by-line).
    // Gating on isForeground makes every non-TTY context emit structured JSON.
    const pretty = Boolean(config.prettyPrint) && isForeground;

    // Passing `base` replaces pino's default ({pid, hostname}), so re-seed
    // those alongside the deployment context.
    const base = {
      pid: process.pid,
      hostname: hostname(),
      ...resolveDeploymentBindings(),
    };

    // pino's ESM default interop (CJS package, ESM consumer).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinoFn: any = (pino as any).default ?? pino;

    // Production Express context (e.g. ECS/Fargate): write structured JSON
    // straight to a file descriptor via a direct pino.destination stream
    // (default fd 1 = stdout; an explicit logFile overrides). pino's
    // transport mechanism runs in a worker thread that crashes on process
    // fds (/dev/stdout, /proc/1/fd/1) in Fargate, so the previous workaround
    // logged to a /tmp file that never reached CloudWatch. A main-thread
    // SonicBoom stream on stdout is reliable and is captured by the awslogs
    // driver → CloudWatch.
    if (env === 'production' && isExpressContext) {
      const dest = pinoFn.destination({ dest: logFile ?? 1, sync: false });
      this.logger = pinoFn(
        { level: config.level, redact, base, mixin: traceCorrelationMixin },
        dest,
      );
      this.logger.info(`Logger initialized with level ${config.level}`);
      return;
    }

    const targets: TransportTargetOptions[] = [];

    // NODE_ENV=local
    if (env === 'local') {
      // Always console logger
      targets.push({
        target: pretty ? 'pino-pretty' : 'pino/file',
        options: pretty
          ? {
              colorize: true,
              levelFirst: true,
              translateTime: 'SYS:standard',
            }
          : { destination: 1 }, // STDOUT
      });
      // File logger if specified
      if (logFile) {
        targets.push({
          target: 'pino/file',
          options: { destination: logFile },
        });
      }
    }
    // NODE_ENV=development
    else if (env === 'development') {
      if (isExpressContext && isForeground) {
        targets.push({
          target: pretty ? 'pino-pretty' : 'pino/file',
          options: pretty
            ? {
                colorize: true,
                levelFirst: true,
                translateTime: 'SYS:standard',
              }
            : { destination: 1 },
        });
      }
      if (logFile) {
        targets.push({
          target: 'pino/file',
          options: { destination: logFile },
        });
      }
    }
    // NODE_ENV=production + Express context is handled by the early-return
    // above (direct stdout destination). Production without Express context
    // falls through to the console fallback below.
    // Fallback/default: always log to console
    if (targets.length === 0) {
      targets.push({
        target: pretty ? 'pino-pretty' : 'pino/file',
        options: pretty
          ? {
              colorize: true,
              levelFirst: true,
              translateTime: 'SYS:standard',
            }
          : { destination: 1 },
      });
    }

    this.logger = pinoFn({
      level: config.level,
      redact,
      base,
      mixin: traceCorrelationMixin,
      transport: {
        targets,
      },
    });

    this.logger.info(`Logger initialized with level ${config.level}`);
  }

  public info(message: string, data?: object): void {
    if (data) {
      this.logger.info(data, message);
    } else {
      this.logger.info(message);
    }
  }

  public warn(message: string, data?: object): void {
    if (data) {
      this.logger.warn(data, message);
    } else {
      this.logger.warn(message);
    }
  }

  public error(message: string, error?: Error, data?: object): void {
    const logObject = { ...data, err: error };
    this.logger.error(logObject, message);
  }

  public debug(message: string, data?: object): void {
    if (data) {
      this.logger.debug(data, message);
    } else {
      this.logger.debug(message);
    }
  }
}
