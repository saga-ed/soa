import { Writable } from 'node:stream';
import pino from 'pino';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import {
  PinoLogger,
  redact,
  traceCorrelationMixin,
  resolveDeploymentBindings,
} from '../pino-logger.js';
import { PinoLoggerConfig } from '../pino-logger-schema.js';
import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Capture pino output synchronously by handing it a plain Writable sink.
 * pino writes to its second-arg stream in-process (no worker thread, no
 * SonicBoom flush timing), so the redaction assertions are deterministic.
 * This exercises the exact `redact` config the PinoLogger class wires into
 * both of its construction paths.
 */
function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    get text() {
      return text;
    },
  };
}

// Helper to mock process.stdout.isTTY
function withTTY(value: boolean, fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  try {
    fn();
  } finally {
    if (original) {
      Object.defineProperty(process.stdout, 'isTTY', original);
    }
  }
}

describe('PinoLogger', () => {
  const baseConfig: Omit<PinoLoggerConfig, 'isExpressContext'> = {
    configType: 'PINO_LOGGER',
    level: 'info',
    prettyPrint: false,
  };

  afterEach(() => {
    vi.resetModules();
    delete process.env.NODE_ENV;
  });

  it('should use isExpressContext from config (DI)', () => {
    const config: PinoLoggerConfig = { ...baseConfig, isExpressContext: true };
    withTTY(true, () => {
      process.env.NODE_ENV = 'development';
      expect(() => new PinoLogger(config)).not.toThrow();
    });
  });

  it('should detect isForeground using process.stdout.isTTY', () => {
    const config: PinoLoggerConfig = { ...baseConfig, isExpressContext: true };
    process.env.NODE_ENV = 'development';
    let logger: PinoLogger | undefined;
    withTTY(true, () => {
      expect(() => {
        logger = new PinoLogger(config);
      }).not.toThrow();
    });
    withTTY(false, () => {
      expect(() => {
        logger = new PinoLogger(config);
      }).not.toThrow();
    });
  });

  it('should default to stdout (fd 1) in production Express context without logFile', () => {
    // No longer throws: a missing logFile now means "log structured JSON to
    // stdout via a direct pino.destination stream" (CloudWatch via awslogs).
    const config: PinoLoggerConfig = { ...baseConfig, isExpressContext: true };
    process.env.NODE_ENV = 'production';
    withTTY(false, () => {
      expect(() => new PinoLogger(config)).not.toThrow();
    });
  });

  it('should not throw if logFile is present in production Express context', () => {
    const config: PinoLoggerConfig = {
      ...baseConfig,
      isExpressContext: true,
      logFile: '/tmp/test.log',
    };
    process.env.NODE_ENV = 'production';
    withTTY(true, () => {
      expect(() => new PinoLogger(config)).not.toThrow();
    });
  });

  it('should instantiate both console and file loggers in local with logFile', () => {
    const config: PinoLoggerConfig = {
      ...baseConfig,
      isExpressContext: false,
      logFile: '/tmp/test.log',
    };
    process.env.NODE_ENV = 'local';
    withTTY(true, () => {
      expect(() => new PinoLogger(config)).not.toThrow();
    });
  });

  describe('PII redaction (shared `redact` config)', () => {
    // A bad path list (e.g. ancestor/descendant overlap) makes pino's
    // fast-redact throw at construction — which would crash this shared
    // logger fleet-wide. Constructing a logger with `redact` is the guard.
    it('does not throw when constructing pino with the redact config', () => {
      expect(() => pino({ redact }, sink().stream)).not.toThrow();
    });

    it('redacts email in a structured field', () => {
      const s = sink();
      pino({ redact }, s.stream).info({ email: 'alice@example.org' }, 'lookup');
      expect(s.text).toContain('[REDACTED]');
      expect(s.text).not.toContain('alice@example.org');
    });

    it('redacts a nested email one level deep (*.email)', () => {
      const s = sink();
      pino({ redact }, s.stream).info({ user: { email: 'bob@example.org' } }, 'sync');
      expect(s.text).not.toContain('bob@example.org');
    });

    it('redacts student name + dob (FERPA search criteria)', () => {
      const s = sink();
      pino({ redact }, s.stream).info(
        { firstNameNorm: 'jane', lastNameNorm: 'doe', dob: '2010-05-01' },
        'student.search'
      );
      expect(s.text).not.toContain('jane');
      expect(s.text).not.toContain('doe');
      expect(s.text).not.toContain('2010-05-01');
    });

    it('redacts a whole request input/payload/body object wholesale', () => {
      const s = sink();
      pino({ redact }, s.stream).error(
        { input: { email: 'c@example.org', extra: 'secret-value' } },
        'validation failed'
      );
      expect(s.text).not.toContain('c@example.org');
      expect(s.text).not.toContain('secret-value');
    });

    it('redacts secrets (password, token, clientSecret)', () => {
      const s = sink();
      pino({ redact }, s.stream).info(
        { password: 'hunter2', token: 'eyJ...', clientSecret: 'shh' },
        'auth'
      );
      expect(s.text).not.toContain('hunter2');
      expect(s.text).not.toContain('eyJ...');
      expect(s.text).not.toContain('shh');
    });

    it('does NOT redact `code` (tRPC error codes / district codes are not PII)', () => {
      const s = sink();
      pino({ redact }, s.stream).error({ code: 'NOT_FOUND' }, 'lookup miss');
      expect(s.text).toContain('NOT_FOUND');
    });

    it('does NOT redact PII interpolated into the message string (documents the limit)', () => {
      // pino's redact masks structured KEYS only — never message text. This
      // is why request-logger strips the query string and PII-bearing reads
      // move to POST; redaction is defense-in-depth, not the whole fix.
      const s = sink();
      pino({ redact }, s.stream).info('looked up alice@example.org');
      expect(s.text).toContain('alice@example.org');
    });
  });

  describe('trace/log correlation (`mixin` config)', () => {
    // `trace.getActiveSpan()` reads from the GLOBAL context manager, not
    // from the provider/tracer directly — `startActiveSpan` is a no-op for
    // propagation unless both the provider AND a context manager are
    // registered globally (sdk-trace-base ships neither by default; real
    // services get this via `NodeSDK.start()` in soa-observability).
    const provider = new BasicTracerProvider();
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
    const tracer = provider.getTracer('pino-logger.unit.test');

    it('adds no trace_id/span_id when there is no active span', () => {
      const s = sink();
      pino({ mixin: traceCorrelationMixin }, s.stream).info('startup');
      const line = JSON.parse(s.text);
      expect(line.trace_id).toBeUndefined();
      expect(line.span_id).toBeUndefined();
    });

    it("adds trace_id/span_id matching the active span, in Datadog's expected hex format", () => {
      const s = sink();
      const logger = pino({ mixin: traceCorrelationMixin }, s.stream);

      tracer.startActiveSpan('test-span', span => {
        const spanContext = span.spanContext();
        logger.info('handled request');

        const line = JSON.parse(s.text);
        expect(line.trace_id).toBe(spanContext.traceId);
        expect(line.span_id).toBe(spanContext.spanId);
        expect(line.trace_id).toMatch(/^[0-9a-f]{32}$/);
        expect(line.span_id).toMatch(/^[0-9a-f]{16}$/);

        span.end();
      });
    });

    it('does not collide with PII redaction when both are configured together', () => {
      const s = sink();
      const logger = pino({ redact, mixin: traceCorrelationMixin }, s.stream);

      tracer.startActiveSpan('test-span-2', span => {
        logger.info({ email: 'alice@example.org' }, 'lookup');
        const line = JSON.parse(s.text);
        expect(line.email).toBe('[REDACTED]');
        expect(line.trace_id).toBe(span.spanContext().traceId);
        span.end();
      });
    });
  });

  describe('deployment context (`base` bindings from OTEL_RESOURCE_ATTRIBUTES)', () => {
    it('parses deployment.environment.name and deployment.identifier', () => {
      expect(
        resolveDeploymentBindings(
          'deployment.environment=dev,deployment.environment.name=dev,deployment.identifier=main',
        ),
      ).toEqual({
        deployment: { environment: { name: 'dev' }, identifier: 'main' },
      });
    });

    it('falls back to the pre-1.27 semconv key deployment.environment', () => {
      expect(
        resolveDeploymentBindings('deployment.environment=dev,deployment.identifier=pr-42'),
      ).toEqual({
        deployment: { environment: { name: 'dev' }, identifier: 'pr-42' },
      });
    });

    it('returns {} when the env var is unset or has no deployment keys (degrade-safe)', () => {
      expect(resolveDeploymentBindings(undefined)).toEqual({});
      expect(resolveDeploymentBindings('')).toEqual({});
      expect(resolveDeploymentBindings('service.version=abc123')).toEqual({});
    });

    it('tolerates whitespace, malformed pairs, and percent-encoded values', () => {
      expect(
        resolveDeploymentBindings(
          ' deployment.identifier = sandbox%2De2e%2D626 ,notakeyvalue,=orphan',
        ),
      ).toEqual({ deployment: { identifier: 'sandbox-e2e-626' } });
    });

    it('keeps a value raw when percent-decoding fails rather than dropping it', () => {
      expect(resolveDeploymentBindings('deployment.identifier=100%main')).toEqual({
        deployment: { identifier: '100%main' },
      });
    });

    it('stamps deployment context on every log line via pino `base`', () => {
      // Mirrors the PinoLogger constructor's base wiring: this is what makes
      // Datadog's @deployment.identifier log facet line up with the identical
      // span resource attribute, so one filter isolates a sandbox deployment
      // across logs AND traces.
      const s = sink();
      const logger = pino(
        {
          base: resolveDeploymentBindings(
            'deployment.environment.name=dev,deployment.identifier=sandbox-e2e-626',
          ),
        },
        s.stream,
      );
      logger.info('first');
      logger.info({ userId: 'u1' }, 'second');

      const lines = s.text.trim().split('\n').map(l => JSON.parse(l));
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line.deployment).toEqual({
          environment: { name: 'dev' },
          identifier: 'sandbox-e2e-626',
        });
      }
    });

    it('does not collide with PII redaction (deployment keys are never redacted)', () => {
      const s = sink();
      const logger = pino(
        {
          redact,
          base: resolveDeploymentBindings('deployment.identifier=main'),
        },
        s.stream,
      );
      logger.info({ email: 'alice@example.org' }, 'lookup');
      const line = JSON.parse(s.text);
      expect(line.email).toBe('[REDACTED]');
      expect(line.deployment.identifier).toBe('main');
    });

    it('constructs PinoLogger without throwing when OTEL_RESOURCE_ATTRIBUTES is set', () => {
      const prev = process.env.OTEL_RESOURCE_ATTRIBUTES;
      process.env.OTEL_RESOURCE_ATTRIBUTES =
        'deployment.environment.name=dev,deployment.identifier=main';
      try {
        process.env.NODE_ENV = 'production';
        const config: PinoLoggerConfig = { ...baseConfig, isExpressContext: true };
        withTTY(false, () => {
          expect(() => new PinoLogger(config)).not.toThrow();
        });
      } finally {
        if (prev === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
        else process.env.OTEL_RESOURCE_ATTRIBUTES = prev;
      }
    });
  });
});
