import { Get, Controller } from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import type { ExpressServerConfig } from '@hipponot/soa-api-core/express-server-schema';
import { AbstractRestController } from '@hipponot/soa-api-core';

const SECTOR = 'session';

@Controller(`/${SECTOR}`)
@injectable()
export class SessionRestController extends AbstractRestController {
    readonly sectorName = SECTOR;
    constructor(
        @inject('ILogger') logger: ILogger,
        @inject('ExpressServerConfig') serverConfig?: ExpressServerConfig
    ) {
        super(logger, SECTOR, serverConfig);
    }

    @Get('/test-route')
    testRoute() {
        this.logger.info('Session REST route hit');
        return 'Session REST route OK';
    }

    async init() {
        // Async setup if needed
    }
}
