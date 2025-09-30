import { Get, Controller } from 'routing-controllers';
import type { Request, Response } from 'express';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import type { ExpressServerConfig } from '@hipponot/soa-api-core/express-server-schema';
import { AbstractRestController } from '@hipponot/soa-api-core/abstract-rest-controller';

const SECTOR = 'hello-mongo';

@Controller(`/${SECTOR}`)
@injectable()
export class HelloMongo extends AbstractRestController {
  readonly sectorName = SECTOR;
  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
  ) {
    super(logger, SECTOR, serverConfig);
  }

  @Get('/test-route')
  testRoute() {
    this.logger.info('Hello mongo route hit');
    return 'Hello Mongo';
  }

  async init() {
    // Async setup if needed
  }
}
