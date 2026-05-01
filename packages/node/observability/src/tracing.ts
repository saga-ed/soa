import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { ILogger } from '@saga-ed/soa-logger';

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
        resource: new Resource({
            [ATTR_SERVICE_NAME]: serviceName,
        }),
        traceExporter: new OTLPTraceExporter({ url: resolveOtlpTracesUrl() }),
    });

    if (process.env.OTEL_TRACES_DISABLED !== 'true') {
        sdk.start();
    }

    return sdk;
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
