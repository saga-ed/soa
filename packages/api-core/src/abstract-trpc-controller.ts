import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const router = t.router;
export const publicProcedure = t.procedure;

export abstract class AbstractTRPCController {
  static readonly controllerType = 'TRPC';
  protected logger: ILogger;
  abstract readonly sectorName: string;

  constructor(@inject('ILogger') logger: ILogger) {
    this.logger = logger;
  }

  createProcedure() {
    return publicProcedure;
  }
}
