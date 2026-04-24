/**
 * FixtureServer — ready-to-run Express server for fixture management.
 *
 * Wraps soa-api-core's ExpressServer with:
 * - Inversify DI container with standard bindings
 * - infra-compose router at /infra with configurable lifecycle hooks
 * - Controller discovery (explicit array or glob pattern)
 * - Health endpoint with version and active profile
 * - Optional admin registration
 *
 * @example
 * ```ts
 * import { FixtureServer } from '@saga-ed/fixture-serve';
 * import { MyFixtureController } from './controllers/fixture.controller.js';
 *
 * const server = new FixtureServer({
 *   port: 7777,
 *   service_name: 'my_api-*',
 *   health_url: 'http://localhost:4000/health',
 *   mongo_uri: 'mongodb://localhost:27017',
 *   db_name: 'my_db',
 *   default_profile: 'my-api',
 *   controllers: [MyFixtureController],
 * });
 * await server.start();
 * ```
 */

import 'reflect-metadata';
import { Container } from 'inversify';
import type { ILogger, PinoLoggerConfig } from '@saga-ed/soa-logger';
import { PinoLogger } from '@saga-ed/soa-logger';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { ControllerLoader } from '@saga-ed/soa-api-core/utils/controller-loader';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core';
import { AbstractRestController } from '@saga-ed/soa-api-core';
import { MongoProvider, MONGO_CLIENT } from '@saga-ed/soa-db';
import type { IMongoConnMgr } from '@saga-ed/soa-db';
import type { MongoClient } from 'mongodb';
import { get_active_profile } from '@saga-ed/infra-compose';
import { create_router as create_infra_router } from '@saga-ed/infra-compose/router';
import { create_service_restarter } from '../utils/service-restart.js';
import { register_with_admin } from './admin-registration.js';
import type { FixtureControllerConfig } from '../controller/abstract-fixture-controller.js';

export interface FixtureServerConfig {
    /** Port to listen on. */
    port: number;

    /** Systemd unit pattern for service restart (e.g. "saga_api-*"). */
    service_name: string;

    /** Health check URL for the application service (e.g. "http://localhost:3000/health"). */
    health_url: string;

    /** MongoDB connection URI. */
    mongo_uri: string;

    /** MongoDB database name for fixture metadata and jobs. */
    db_name: string;

    /** SQL host:port (e.g. "localhost:3306"). */
    sql_host?: string;

    /** Base site URL (e.g. "https://snapper.wootmath.com"). */
    site_url?: string;

    /** Default infra-compose profile name for reset operations. */
    default_profile?: string;

    /** Fixture-admin registration URL. Omit to skip registration. */
    admin_register_url?: string;

    /** Controller classes to register. */
    controllers?: Array<new (...args: any[]) => any>;

    /** Glob pattern for auto-discovering controllers (alternative to explicit array). */
    controller_glob?: string;

    /** Override infra-compose lifecycle hooks. Defaults to restarting the service. */
    infra_hooks?: {
        on_after_switch?: () => Promise<void>;
        on_after_reset?: () => Promise<void>;
        on_after_snapshot?: () => Promise<void>;
    };

    /** Log level. Default: 'info'. */
    log_level?: 'debug' | 'info' | 'warn' | 'error';

    /** MongoDB collection name for fixture metadata. Default: 'fixture_metadata'. */
    metadata_collection?: string;

    /** MongoDB collection name for async jobs. Default: 'fixture_jobs'. */
    jobs_collection?: string;

    /** Package version string for health endpoint. Auto-detected if omitted. */
    version?: string;

    /** Server display name. Default: 'fixture-server'. */
    name?: string;

    /** Path to a project-specific docker-compose.yml for infra-compose operations. */
    compose_file?: string;
}

export class FixtureServer {
    /** DI container — exposed for infra_hooks that need MongoDB reconnection or other bindings. */
    container!: Container;
    private express_server!: ExpressServer;

    constructor(private config: FixtureServerConfig) {}

    async start(): Promise<void> {
        const config = this.config;
        const log_level = config.log_level || 'info';
        const server_name = config.name || 'fixture-server';
        const version = config.version || 'unknown';

        // 1. Create DI container
        this.container = new Container();

        this.container.bind<PinoLoggerConfig>('PinoLoggerConfig').toConstantValue({
            configType: 'PINO_LOGGER',
            level: log_level,
            isExpressContext: true,
            prettyPrint: true,
        });
        this.container.bind<ILogger>('ILogger').to(PinoLogger).inSingletonScope();

        const express_config: ExpressServerConfig = {
            configType: 'EXPRESS_SERVER',
            port: config.port,
            logLevel: log_level,
            name: server_name,
        };
        this.container.bind<ExpressServerConfig>('ExpressServerConfig').toConstantValue(express_config);

        const ctrl_config: FixtureControllerConfig = {
            mongo_uri: config.mongo_uri,
            db_name: config.db_name,
            sql_host: config.sql_host,
            site_url: config.site_url,
            default_profile: config.default_profile,
            metadata_collection: config.metadata_collection,
            jobs_collection: config.jobs_collection,
            compose_file: config.compose_file,
        };
        this.container.bind<FixtureControllerConfig>('FixtureControllerConfig').toConstantValue(ctrl_config);

        // MongoDB via MongoProvider — connection is established during DI resolution
        const parsed_uri = new URL(config.mongo_uri.replace('mongodb://', 'http://'));
        this.container.bind<IMongoConnMgr>('IMongoConnMgr').toDynamicValue(async () => {
            const provider = new MongoProvider({
                configType: 'MONGO',
                instanceName: 'fixture-db',
                host: parsed_uri.hostname,
                port: parseInt(parsed_uri.port || '27017', 10),
                database: config.db_name,
                options: { directConnection: true, serverSelectionTimeoutMS: 30000 },
            });
            await provider.connect();
            return provider;
        }).inSingletonScope();

        this.container.bind<MongoClient>(MONGO_CLIENT).toDynamicValue(async () => {
            const mgr = await this.container.getAsync<IMongoConnMgr>('IMongoConnMgr');
            return mgr.getClient();
        }).inSingletonScope();

        this.container.bind(ExpressServer).toSelf().inSingletonScope();
        this.container.bind(ControllerLoader).toSelf().inSingletonScope();

        // 2. Discover controllers
        let controllers: Array<new (...args: any[]) => any>;
        if (config.controllers && config.controllers.length > 0) {
            controllers = config.controllers;
        } else if (config.controller_glob) {
            const loader = this.container.get(ControllerLoader);
            controllers = await loader.loadControllers(config.controller_glob, AbstractRestController);
        } else {
            throw new Error('FixtureServer: either controllers or controller_glob must be provided');
        }

        // 3. Set up Express app
        // CORS and body parsing are handled by ExpressServer.init() —
        // api-core applies cors() middleware and routing-controllers parses @Body() params.
        this.express_server = this.container.get(ExpressServer);
        const app = this.express_server.getApp();

        // 4. Mount infra-compose router with lifecycle hooks
        const logger = this.container.get<ILogger>('ILogger');
        const restart_fn = create_service_restarter(config.service_name, config.health_url);
        // Reconnect MongoDB after volume swaps so queries hit the new profile's data.
        // Without this, the controller's metadata_collection reads stale documents
        // from the previous profile's connection.
        const reconnect_mongo = async () => {
            const mgr = await this.container.getAsync<IMongoConnMgr>('IMongoConnMgr');
            await mgr.disconnect();
            await mgr.connect();
            logger.info('infra hook: reconnected MongoDB after profile change');
        };
        const infra_router = create_infra_router({
            compose_file: config.compose_file,
            on_after_switch: config.infra_hooks?.on_after_switch ?? (async () => {
                await reconnect_mongo();
                await restart_fn(logger);
            }),
            on_after_reset: config.infra_hooks?.on_after_reset ?? (async () => {
                await reconnect_mongo();
                await restart_fn(logger);
            }),
            on_after_snapshot: config.infra_hooks?.on_after_snapshot,
        });
        app.use('/infra', infra_router);

        // 5. Init controllers
        await this.express_server.init(this.container, controllers);

        // 6. Health endpoint
        app.get('/health', (_req, res) => {
            const active = get_active_profile();
            res.json({
                status: 'ok',
                service: server_name,
                version,
                port: config.port,
                active_profile: active,
            });
        });

        // 7. Start listening
        this.express_server.start();

        // 8. Optional admin registration
        const admin_url = config.admin_register_url || process.env.FIXTURE_ADMIN_URL;
        if (admin_url) {
            register_with_admin({
                admin_url,
                port: config.port,
                site_url: config.site_url || '',
                version,
            }, logger);
        }

        // 9. Graceful shutdown
        const shutdown = async () => {
            try {
                const mgr = await this.container.getAsync<IMongoConnMgr>('IMongoConnMgr');
                await mgr.disconnect();
            } catch { /* container may not have resolved yet */ }
            this.express_server.stop();
            process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }

    stop(): void {
        this.express_server?.stop();
    }

    getApp() {
        return this.express_server?.getApp();
    }

    getContainer(): Container {
        return this.container;
    }
}
