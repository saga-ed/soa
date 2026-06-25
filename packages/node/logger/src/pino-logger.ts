import { injectable, inject } from 'inversify';
import pino, { Logger, TransportTargetOptions } from 'pino';
import { ILogger } from './i-logger.js';
import type { PinoLoggerConfig } from './pino-logger-schema.js';

// ---------------------------------------------------------------------------
// PII Redaction paths
// ---------------------------------------------------------------------------
// Pino uses fast-redact to censor these field paths before serialisation.
// Design rationale:
//
//   Field-level paths (preferred):
//     We list specific leaf keys rather than nuking whole parent objects like
//     `user` or `student`.  Redacting the whole object would hide useful
//     non-PII fields (e.g. user.id, user.role) that matter for debugging.
//     One-level wildcard (`*.email`) covers nested PII when the parent key
//     isn't known at logging time.
//
//   Wholesale paths (high-risk, low-debug-value):
//     `req.body` and `*.body`  — POST bodies commonly contain passwords,
//       PII forms, or tokens; the raw body is almost never needed in logs.
//     `req.headers.authorization` / `headers.authorization` — Bearer tokens.
//
// Wildcard syntax:
//   fast-redact supports `a.b`, `*.b`, and optionally `a[*].b`.
//   We deliberately avoid `*.*.email` (double-star nesting) because its
//   validity in fast-redact's compiled mode is not confirmed and a bad
//   path throws at Pino construction — crashing EVERY service at startup.
//   Prefer the documented conservative forms.
//
// Censor value:
//   Pino's default "[Redacted]" — we keep the key present so it is obvious
//   in logs that a value was intentionally censored (more debuggable than
//   `remove: true` which would silently drop the key).
// ---------------------------------------------------------------------------
export const REDACT_PATHS: string[] = [
  // --- Email ---
  'email',
  '*.email',
  'user.email',
  'req.body.email',

  // --- Auth / secrets (wholesale body + auth header) ---
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  '*.authorization',
  'req.headers.authorization',
  'headers.authorization',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  // Wholesale: POST bodies almost always contain credentials or PII forms;
  // raw bodies are rarely useful in structured logs.
  'req.body',
  '*.body',

  // --- Identity PII (student / staff space) ---
  // Top-level forms: catch bare `logger.info({ ssn, phone, ... })` calls.
  // Wildcard forms: catch the common nested shape `{ user: { ssn }, student: { phone } }`.
  'firstName',
  'lastName',
  '*.firstName',
  '*.lastName',
  'dob',
  '*.dob',
  'dateOfBirth',
  '*.dateOfBirth',
  'ssn',
  '*.ssn',
  'phone',
  '*.phone',
  'phoneNumber',
  '*.phoneNumber',
  'address',
  '*.address',
];

@injectable()
export class PinoLogger implements ILogger {
  private readonly logger: Logger;

  constructor(@inject('PinoLoggerConfig') private config: PinoLoggerConfig) {
    const env = process.env.NODE_ENV || 'development';
    const isForeground = Boolean(process.stdout.isTTY);
    const isExpressContext = config.isExpressContext;
    const logFile = config.logFile;

    // pino's ESM default interop (CJS package, ESM consumer).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pinoFn: any = (pino as any).default ?? pino;

    // Shared base options applied to BOTH instantiation sites below.
    // Both the production/Express direct-destination path and the transport
    // path (local/dev) must carry identical redact config — a redact that
    // only exists on one path silently leaves the other unprotected.
    //
    // TODO(E4): trace-context mixin slots in here — add a `mixin` key to
    //   baseOptions that injects dd.trace_id / dd.span_id from the active
    //   Datadog APM context.  Do NOT implement here; this is the hook point.
    const baseOptions = {
      level: config.level,
      redact: { paths: REDACT_PATHS },
    };

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
      this.logger = pinoFn(baseOptions, dest);
      this.logger.info(`Logger initialized with level ${config.level}`);
      return;
    }

    const targets: TransportTargetOptions[] = [];

    // NODE_ENV=local
    if (env === 'local') {
      // Always console logger
      targets.push({
        target: config.prettyPrint ? 'pino-pretty' : 'pino/file',
        options: config.prettyPrint
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
          target: config.prettyPrint ? 'pino-pretty' : 'pino/file',
          options: config.prettyPrint
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
        target: config.prettyPrint ? 'pino-pretty' : 'pino/file',
        options: config.prettyPrint
          ? {
              colorize: true,
              levelFirst: true,
              translateTime: 'SYS:standard',
            }
          : { destination: 1 },
      });
    }

    this.logger = pinoFn({
      ...baseOptions,
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
