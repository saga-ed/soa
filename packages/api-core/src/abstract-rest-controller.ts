import {
  Get,
  Controller,
  getMetadataArgsStorage,
  Req,
  Res,
  HeaderParams,
} from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ExpressServerConfig } from './express-server-schema.js';
import figlet from 'figlet';
import type { Request, Response } from 'express';

export abstract class AbstractRestController {
  static readonly controllerType = 'REST';
  private static _controllers: Function[] = [];
  protected logger: ILogger;
  protected serverConfig?: ExpressServerConfig;

  abstract readonly sectorName: string;

  constructor(
    logger: ILogger,
    public readonly _sectorName: string,
    serverConfig?: ExpressServerConfig
  ) {
    this.logger = logger;
    this.serverConfig = serverConfig;
  }

  @Get('/')
  home() {
    const splash = figlet.textSync(this.sectorName, { font: 'Standard' });
    return `<pre>${splash}</pre>`;
  }

  @Get('/alive')
  alive() {
    return {
      status: 'alive',
      sector: this.sectorName,
      port: this.serverConfig?.port
    };
  }

  // Removed the /sectors route from here
}
