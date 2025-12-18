import { Get, Controller } from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core/express-server-schema';
import { AbstractRestController } from '@saga-ed/soa-api-core';

const SECTOR = 'user';

@Controller(`/${SECTOR}`)
@injectable()
export class UserRestController extends AbstractRestController {
    readonly sectorName = SECTOR;
    constructor(
        @inject('ILogger') logger: ILogger,
        @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
    ) {
        super(logger, SECTOR, serverConfig);
    }

    @Get('/test-route')
    testRoute() {
        this.logger.info('User REST route hit');
        return 'User REST route OK';
    }

    async init() {
        // Async setup if needed
    }
}
