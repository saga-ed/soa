import { Get, Controller } from 'routing-controllers';
import type { Request, Response } from 'express';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core/express-server-schema';
import { AbstractRestController } from '@saga-ed/soa-api-core/abstract-rest-controller';

const SECTOR = 'hello';

@Controller(`/${SECTOR}`)
@injectable()
export class HelloRest extends AbstractRestController {
  readonly sectorName = SECTOR;
  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
  ) {
    super(logger, SECTOR, serverConfig);
  }

  @Get('/test-route')
  testRoute() {
    this.logger.info('Hello route hit');
    return 'Hello';
  }

  async init() {
    // Async setup if needed
  }
}
