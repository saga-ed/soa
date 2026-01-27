import { injectable } from 'inversify';
import { ILogger, LogLevel } from '../i-logger.js';

interface LogEntry {
  level: LogLevel;
  message: string;
  data?: object;
  error?: Error;
}

@injectable()
export class MockLogger implements ILogger {
  public logs: LogEntry[] = [];

  public info(message: string, data?: object): void {
    this.logs.push({ level: 'info', message, data });
  }

  public warn(message: string, data?: object): void {
    this.logs.push({ level: 'warn', message, data });
  }

  public error(message: string, error?: Error, data?: object): void {
    this.logs.push({ level: 'error', message, error, data });
  }

  public debug(message: string, data?: object): void {
    this.logs.push({ level: 'debug', message, data });
  }

  public clear(): void {
    this.logs = [];
  }
}
