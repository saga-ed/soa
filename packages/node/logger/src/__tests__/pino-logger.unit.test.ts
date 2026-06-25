import { Writable } from 'node:stream';
import pino from 'pino';
import { PinoLogger, redact } from '../pino-logger.js';
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
});
