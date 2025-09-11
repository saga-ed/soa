import { Get, Controller } from 'routing-controllers';
import type { Request, Response } from 'express';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/logger';
import { AbstractRestController } from '@hipponot/api-core/abstract-rest-controller';

const SECTOR = 'hello-mongo';

@Controller(`/${SECTOR}`)
@injectable()
export class HelloMongo extends AbstractRestController {
  readonly sectorName = SECTOR;
  constructor(@inject('ILogger') logger: ILogger) {
    super(logger, SECTOR);
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
