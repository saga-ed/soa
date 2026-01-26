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
    const targets: TransportTargetOptions[] = [];

    // Enforce production Express context rule
    if (env === 'production' && isExpressContext && !logFile) {
      throw new Error('In production Express context, logFile must be specified for the logger.');
    }

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
    // NODE_ENV=production
    else if (env === 'production') {
      if (isExpressContext) {
        // Always file logger (already enforced above)
        targets.push({
          target: 'pino/file',
          options: { destination: logFile! },
        });
        if (isForeground) {
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
      }
    }
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

    // Use pino.default if available (ESM interop), otherwise pino (CJS)
    // @ts-ignore
    this.logger = (pino as any).default
      ? (pino as any).default({
          level: config.level,
          transport: {
            targets,
          },
        })
      : (pino as any)({
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
