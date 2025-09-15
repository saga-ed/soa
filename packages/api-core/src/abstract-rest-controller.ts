import {
  Get,
  Controller,
  getMetadataArgsStorage,
  Req,
  Res,
  HeaderParams,
} from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import figlet from 'figlet';
import type { Request, Response } from 'express';

export abstract class AbstractRestController {
  private static _controllers: Function[] = [];
  protected logger: ILogger;

  abstract readonly sectorName: string;

  constructor(
    logger: ILogger,
    public readonly _sectorName: string
  ) {
    this.logger = logger;
  }

  @Get('/')
  home() {
    const splash = figlet.textSync(this.sectorName, { font: 'Standard' });
    return `<pre>${splash}</pre>`;
  }

  @Get('/alive')
  alive() {
    return { status: 'alive', sector: this.sectorName };
  }

  // Removed the /sectors route from here
}
