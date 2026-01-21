export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ILogger {
  info(message: string, data?: object): void;
  warn(message: string, data?: object): void;
  error(message: string, error?: Error, data?: object): void;
  debug(message: string, data?: object): void;
}
