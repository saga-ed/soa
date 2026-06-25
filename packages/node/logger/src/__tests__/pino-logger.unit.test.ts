import { PinoLogger } from '../pino-logger.js';
import { PinoLoggerConfig } from '../pino-logger-schema.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  // Proves REDACT_PATHS is actually WIRED into the PinoLogger production path
  // (not just that a standalone pino() redacts). Without this, deleting `redact`
  // from baseOptions would leave the unit suite green — the false-confidence
  // gap the pino-redact tests alone don't cover. Uses the prod/Express path
  // (sync pino.destination to a file) so output is readable without a worker.
  it('redacts PII through the PinoLogger production path (redact is wired)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pino-redact-'));
    const logFile = join(dir, 'out.log');
    try {
      const config: PinoLoggerConfig = {
        ...baseConfig,
        isExpressContext: true,
        logFile,
      };
      process.env.NODE_ENV = 'production';
      const logger = new PinoLogger(config);
      logger.info('boot', {
        email: 'a@b.com',
        password: 'hunter2',
        user: { email: 'n@s.edu', id: 7 },
      });

      // Prod path is a sync:false SonicBoom destination → the write lands
      // asynchronously. Flush, then poll the file (bounded) until the line
      // appears, so the assertion isn't racing the buffered write.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinoInstance = (logger as any).logger;
      pinoInstance.flush();

      let entry: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 50 && !entry; attempt++) {
        await new Promise((r) => setTimeout(r, 10));
        let raw = '';
        try {
          raw = readFileSync(logFile, 'utf8');
        } catch {
          /* file may not exist yet */
        }
        const lines = raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        entry = lines.find((l) => l.email !== undefined);
      }
      expect(entry).toBeDefined();
      const e = entry as Record<string, unknown>;
      expect(e.email).toBe('[Redacted]');
      expect(e.password).toBe('[Redacted]');
      const u = e.user as Record<string, unknown>;
      expect(u.email).toBe('[Redacted]');
      expect(u.id).toBe(7); // non-PII survives
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
