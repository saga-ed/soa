import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { ILogger } from '@saga-ed/soa-logger';
import { PiiSanitizingSpanExporter } from './span-sanitizer.js';
import { recordSpanException } from './record-exception.js';

/**
 * Opaque handle to an initialized OTel SDK. Services don't need to import
 * NodeSDK directly — they hold this handle and pass it to `shutdownTracing`.
 */
export interface TracingHandle {
    shutdown: () => Promise<void>;
}

export interface InitTracingOpts {
    /**
     * If supplied, OTel internal diagnostics (exporter failures, batch span
     * processor warnings) flow through this logger instead of console.error.
     * Strongly recommended in production so Jaeger-down / URL-typo errors
     * land in the same log stream as the rest of the service.
     */
    logger?: ILogger;
}

/**
 * Initialize the OTel SDK for a service. Must be called BEFORE any module
 * that calls `trace.getTracer()` — otherwise our manual spans in
 * @saga-ed/soa-event-outbox / @saga-ed/soa-event-consumer silently no-op.
 *
 * Disable at runtime with OTEL_TRACES_DISABLED=true (handy in tests where
 * the OTLP exporter would just dump errors to stderr).
 */
export function initTracing(
    serviceName: string,
    opts: InitTracingOpts = {},
): TracingHandle {
    if (opts.logger) {
        diag.setLogger(makeDiagLogger(opts.logger), DiagLogLevel.WARN);
    }

    const sdk = new NodeSDK({
        // NOTE: no containerDetector on purpose. On ECS bridge networking the
        // app container shares its cgroup with the pause container, so
        // /proc/self/cgroup resolves to the pause container's ID. The Datadog
        // Agent then enriches OTLP spans with the pause container's
        // image_tag / ecs_container_name, shadowing our service.name +
        // deployment.* resource attrs. Letting the DD Agent identify the source
        // container via its own host-IP-based logic keeps the right task/service
        // tags. (Resource attrs from OTEL_RESOURCE_ATTRIBUTES still merge in.)
        resource: new Resource(resolveResourceAttributes(serviceName)),
        // Wrap the OTLP exporter so PII (ids/emails in URL paths + query
        // strings) is stripped from span attributes before they hit the wire.
        // See span-sanitizer.ts for why this is an exporter wrapper (not a
        // SpanProcessor) and the degrade-safe contract.
        traceExporter: new PiiSanitizingSpanExporter(
            new OTLPTraceExporter({ url: resolveOtlpTracesUrl() }),
        ),
        // Auto-instrumentations register HTTP / Express / pg / amqplib / dns /
        // net span emitters at SDK start, so each inbound request gets a real
        // server-entry span + downstream waterfall WITHOUT per-call manual
        // instrumentation. The HTTP server-entry span is also what carries the
        // incoming W3C traceparent from the browser (RUM), so RUM sessions link
        // to the backend trace. fs is excluded — noisy and rarely actionable.
        // RuntimeNodeInstrumentation feeds DD APM's Runtime Metrics panel
        // (heap, event-loop lag, GC).
        //
        // dns + net are excluded for the same reason as fs: they emit a span per
        // socket/lookup (tcp.connect, dns.lookup, tls.connect) that describes
        // transport plumbing, not application work. The useful latency is already
        // on the parent HTTP/pg span that triggered the connection.
        //
        // pg uses requireParentSpan so it only emits inside an existing trace.
        // Connection-pool churn happens on background reconnects with no active
        // parent, which produced a standing ~44 KB/s of `pg - pool.connect` spans
        // in dev — ~65% of the whole dev APM ingest baseline, and the largest
        // single contributor to the APM per-host density monitor firing
        // (2026-07-28). Query + connect spans raised inside a real request or
        // amqplib consumer still have a parent, so they are unaffected; only the
        // parentless churn is dropped. See instrumentation-pg's
        // shouldSkipInstrumentation(), which gates POOL_CONNECT/CONNECT/query.
        instrumentations: [
            getNodeAutoInstrumentations({
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                '@opentelemetry/instrumentation-net': { enabled: false },
                '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
            }),
            new RuntimeNodeInstrumentation(),
        ],
    });

    if (process.env.OTEL_TRACES_DISABLED !== 'true') {
        sdk.start();
        // Gated with sdk.start() (not unconditional) so tests that set
        // OTEL_TRACES_DISABLED=true — the existing convention for opting out
        // of OTel side effects — don't also get a real `process.exit(1)`
        // wired into their test runner.
        installProcessErrorHandlers(opts.logger);
    }

    return sdk;
}

/**
 * Catch what no per-service code does today: a crash that never went through
 * Express or a tRPC procedure (an unawaited rejection, a callback throw, a
 * timer). Node's own default behavior already exits the process on either
 * event — this preserves that exit but records the exception on the active
 * span first, so a fleet-wide crash stops shipping `error: {}` and a bare
 * stderr line with no trace correlation.
 *
 * Registered once per `initTracing()` call (i.e. once per process, since
 * that's meant to run exactly once at bootstrap) — not exported separately,
 * since a second registration would double-record and double-exit.
 */
function installProcessErrorHandlers(logger?: ILogger): void {
    process.on('uncaughtException', (error) => {
        recordSpanException(error);
        logProcessFailure(logger, 'uncaughtException', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        recordSpanException(error);
        logProcessFailure(logger, 'unhandledRejection', error);
        process.exit(1);
    });
}

function logProcessFailure(logger: ILogger | undefined, kind: string, error: Error): void {
    if (logger) {
        logger.error(`${kind} — process exiting`, error);
    } else {
        // eslint-disable-next-line no-console -- no ILogger is guaranteed at
        // process-bootstrap time (initTracing runs before DI container setup
        // in every consumer today); this mirrors Node's own default handler.
        console.error(`${kind} — process exiting`, error);
    }
}

/**
 * Build the OTel resource attributes for a service.
 *
 * `service.name` is always set from the (hardcoded) name the service passes.
 * `service.version` is set from a release identifier when one is plumbed into
 * the container — DD_VERSION (Datadog's convention) or OTEL_SERVICE_VERSION (a
 * local convenience fallback, NOT an OTel-standard variable — the spec route
 * is OTEL_RESOURCE_ATTRIBUTES=service.version=...). This powers Datadog APM
 * Deployment Tracking ("which release introduced this regression?"). It is
 * OPTIONAL and degrade-safe: with nothing wired the version attr is simply
 * omitted (today's behavior), and the service's CI is expected to pass the
 * build's git SHA as DD_VERSION.
 *
 * Anything in OTEL_RESOURCE_ATTRIBUTES (e.g. deployment.environment.name set by
 * docker-entrypoint.sh) is merged on top of this base by the SDK's env
 * detector. NOTE: on a key collision the env-detected value WINS over the
 * values seeded here — so an operator-set service.name/service.version in
 * OTEL_RESOURCE_ATTRIBUTES would override these defaults (harmless today, since
 * nothing sets those keys via env; worth knowing before one does).
 *
 * Exported for unit testing (initTracing boots the real SDK, so this pure
 * helper is the clean seam to assert the DD_VERSION precedence + omit-on-unset).
 */
export function resolveResourceAttributes(
    serviceName: string,
): Record<string, string> {
    const attrs: Record<string, string> = {
        [ATTR_SERVICE_NAME]: serviceName,
    };
    const version = process.env.DD_VERSION || process.env.OTEL_SERVICE_VERSION;
    if (version) {
        attrs[ATTR_SERVICE_VERSION] = version;
    }
    return attrs;
}

/**
 * Per OTel spec, OTEL_EXPORTER_OTLP_ENDPOINT is the base URL (signal path
 * gets appended) while OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is a full URL
 * (used as-is). Passing a base URL through to OTLPTraceExporter's `url`
 * option silently 404s because that option is treated as full — so we
 * normalize here instead of relying on the SDK's env auto-detection.
 */
function resolveOtlpTracesUrl(): string {
    const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (tracesEndpoint) return tracesEndpoint;

    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (baseEndpoint) {
        return baseEndpoint.endsWith('/v1/traces')
            ? baseEndpoint
            : `${baseEndpoint.replace(/\/$/, '')}/v1/traces`;
    }

    return 'http://localhost:4318/v1/traces';
}

function makeDiagLogger(logger: ILogger): DiagLogger {
    return {
        verbose: () => {},
        debug: () => {},
        info: (msg, ...args) => logger.info(`[otel] ${formatDiag(msg, args)}`),
        warn: (msg, ...args) => logger.warn(`[otel] ${formatDiag(msg, args)}`),
        error: (msg, ...args) => logger.error(`[otel] ${formatDiag(msg, args)}`),
    };
}

function formatDiag(msg: string, args: unknown[]): string {
    if (args.length === 0) return msg;
    return `${msg} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
}

export async function shutdownTracing(
    handle: TracingHandle,
    logger: ILogger,
): Promise<void> {
    try {
        await handle.shutdown();
    } catch (err) {
        // Pending spans in the BatchSpanProcessor's queue are dropped on
        // shutdown failure — typically the most interesting window if the
        // shutdown was triggered by a crash or OOM kill.
        logger.error(
            'OTel SDK shutdown failed — pending spans likely lost',
            err instanceof Error ? err : new Error(String(err)),
        );
    }
}
