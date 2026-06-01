import { injectable, inject } from 'inversify';
import pino, { Logger, TransportTargetOptions } from 'pino';
import { ILogger } from './i-logger.js';
import type { PinoLoggerConfig } from './pino-logger-schema.js';

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
      this.logger = pinoFn({ level: config.level }, dest);
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
      level: config.level,
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
