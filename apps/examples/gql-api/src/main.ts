import 'reflect-metadata';
import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { GQLServer } from '@hipponot/soa-api-core/gql-server';
import { AbstractRestController, AbstractGQLController } from '@hipponot/soa-api-core';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import { container } from './inversify.config.js';
import type { ILogger } from '@hipponot/soa-logger';
import path from 'node:path';
import { fileURLToPath } from 'url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define glob patterns for this API
const GLOB_PATTERNS = {
  REST: './sectors/*/rest/*-routes.js',
  GRAPHQL: './sectors/*/gql/*.resolver.js',
} as const;

async function start() {
  const logger = container.get<ILogger>('ILogger');

  // Get the ControllerLoader from DI
  const controllerLoader = container.get(ControllerLoader);

  // Get the ExpressServer instance from DI
  const expressServer = container.get<ExpressServer>(ExpressServer);

  // Try to load REST controllers, but don't fail if there are none
  let restControllers: any[] = [];
  try {
    restControllers = await controllerLoader.loadControllers(
      path.resolve(__dirname, GLOB_PATTERNS.REST),
      AbstractRestController
    );
  } catch (error: any) {
    // It's okay if there are no REST controllers for a GraphQL-only API
    logger.info('No REST controllers found - running as GraphQL-only API');
    logger.debug('REST controller load error:', error.message || error);
  }

  // Initialize Express server (with or without REST controllers)
  await expressServer.init(container, restControllers);
  const app = expressServer.getApp();

  // Add express.json() middleware before Apollo middleware
  app.use(express.json());

  // Dynamically load all GQL resolvers
  const gqlResolvers = await controllerLoader.loadControllers(
    path.resolve(__dirname, GLOB_PATTERNS.GRAPHQL),
    AbstractGQLController
  );

  // Get the GQLServer instance from DI and initialize it
  const gqlServer = container.get<GQLServer>(GQLServer);
  await gqlServer.init(container, gqlResolvers);

  // Mount the GraphQL server to the Express app with basePath
  gqlServer.mountToApp(app, '/saga-soa/v1');

  // Get server config for port info
  const serverConfig = container.get('ExpressServerConfig');

  // Add a simple health check (at root level for easy access)
  app.get('/health', (req: any, res: any) => {
    res.json({ status: 'ok', service: 'GraphQL SDL API', port: serverConfig.port });
  });

  // Start the server
  expressServer.start();

  // Print useful URLs
  const baseUrl = `http://localhost:${serverConfig.port}`;
  const basePath = serverConfig.basePath ? `/${serverConfig.basePath}` : '';
  logger.info(`Health check: ${baseUrl}/health`);
  logger.info(`Sectors list: ${baseUrl}${basePath}/sectors/list`);
}

start().catch(error => {
  const logger = container.get<ILogger>('ILogger');
  logger.error('Failed to start server:', error);
  process.exit(1);
});
