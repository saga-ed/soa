import 'reflect-metadata';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { ControllerLoader } from '@saga-ed/soa-api-core/utils/controller-loader';
import { AbstractRestController } from '@saga-ed/soa-api-core/abstract-rest-controller';
import { type ExpressServerConfig } from '@saga-ed/soa-api-core';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { container } from './inversify.config.js';
import { appRouter } from './app-router.js';
import type { TRPCContext } from './trpc.js';
import type { ILogger } from '@saga-ed/soa-logger';
import type { Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PubSub imports for event/channel registration
import { PubSubService, TYPES, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { EventDefinition, ChannelConfig } from '@saga-ed/soa-pubsub-core';
import { events } from './sectors/pubsub/trpc/events.js';

// Helpers for context creation
import { ProjectHelper } from './sectors/project/trpc/project-helper.js';
import { RunHelper } from './sectors/run/trpc/run-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define glob patterns for REST controllers only
const GLOB_PATTERNS = {
    REST: './sectors/*/rest/*-routes.js',
} as const;

async function start() {
    const logger = container.get<ILogger>('ILogger');

    // Get the ControllerLoader from DI
    const controllerLoader = container.get(ControllerLoader);

    // Dynamically load all REST controllers
    const restControllers = await controllerLoader.loadControllers(
        path.resolve(__dirname, GLOB_PATTERNS.REST),
        AbstractRestController
    );

    // Get the ExpressServer instance from DI
    const expressServer = container.get(ExpressServer);
    // Initialize the Express server with REST controllers
    await expressServer.init(container, restControllers);
    const app = expressServer.getApp();

    // Add CORS middleware
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        res.header('Access-Control-Allow-Credentials', 'true');

        if (req.method === 'OPTIONS') {
            res.sendStatus(200);
        } else {
            next();
        }
    });

    // Register PubSub events and channels (previously done in PubSubController constructor)
    const pubsubService = container.get<PubSubService>('PubSubService');
    const channelService = container.get<ChannelService>(TYPES.ChannelService);

    try {
        pubsubService.registerEvents(events as unknown as Record<string, EventDefinition>);
        logger.info('PubSub events registered successfully', {
            eventCount: Object.keys(events).length,
            eventNames: Object.keys(events)
        });
    } catch (error) {
        logger.error('Failed to register PubSub events', error instanceof Error ? error : new Error('Unknown error'));
    }

    try {
        const pingpongChannel: ChannelConfig = {
            name: 'pingpong',
            family: 'demo',
            ordered: false,
            maxSubscribers: 100,
            maxEventSize: 1024 * 1024, // 1MB
            historyRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
            authScope: 'user'
        };
        channelService.registerChannels([pingpongChannel]);
        logger.info('PubSub channels registered successfully', {
            channelName: 'pingpong',
            family: 'demo'
        });
    } catch (error) {
        logger.error('Failed to register PubSub channels', error instanceof Error ? error : new Error('Unknown error'));
    }

    // Create shared helper instances for the tRPC context
    const projectHelper = new ProjectHelper();
    const runHelper = new RunHelper();

    // Mount static tRPC router via Express adapter
    app.use(
        '/saga-soa/v1/trpc',
        createExpressMiddleware({
            router: appRouter,
            createContext: (): TRPCContext => ({
                logger,
                pubsubService,
                channelService,
                projectHelper,
                runHelper,
            }),
        }),
    );

    // Get server config for port info
    const serverConfig = container.get<ExpressServerConfig>('ExpressServerConfig');

    // Add a simple health check (at root level for easy access)
    app.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok', service: 'tRPC API', port: serverConfig.port });
    });

    // Start the server
    expressServer.start();

    // Print useful URLs
    const baseUrl = `http://localhost:${serverConfig.port}`;
    const basePath = serverConfig.basePath ? `/${serverConfig.basePath}` : '';
    logger.info(`Health check: ${baseUrl}/health`);
    logger.info(`Sectors list: ${baseUrl}${basePath}/sectors/list`);
}

// Add global error handlers
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

start().catch(error => {
    const logger = container.get<ILogger>('ILogger');
    logger.error('Failed to start server:', error);
    process.exit(1);
});
