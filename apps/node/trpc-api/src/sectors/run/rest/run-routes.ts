import { Get, Controller } from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core/express-server-schema';
import { AbstractRestController } from '@saga-ed/soa-api-core/abstract-rest-controller';

const SECTOR = 'run';

@Controller(`/${SECTOR}`)
@injectable()
export class RunRestController extends AbstractRestController {
  readonly sectorName = SECTOR;
  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
  ) {
    super(logger, SECTOR, serverConfig);
  }

  @Get('/test-route')
  testRoute() {
    this.logger.info('Run REST route hit');
    return 'Run REST route OK';
  }

  async init() {
    // Async setup if needed
  }
} 