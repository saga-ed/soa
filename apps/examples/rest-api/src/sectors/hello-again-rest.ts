import { Get, Controller } from 'routing-controllers';
import type { Request, Response } from 'express';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import type { ExpressServerConfig } from '@hipponot/soa-api-core/express-server-schema';
import { AbstractRestController } from '@hipponot/soa-api-core/abstract-rest-controller';

const SECTOR = 'hello-again';

@Controller(`/${SECTOR}`)
@injectable()
export class HelloAgainRest extends AbstractRestController {
  readonly sectorName = SECTOR;
  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
  ) {
    super(logger, SECTOR, serverConfig);
  }

  @Get('/test-route')
  testRoute() {
    this.logger.info('Hello again route hit');
    return 'Hello Again';
  }

  async init() {
    // Async setup if needed
  }
}
