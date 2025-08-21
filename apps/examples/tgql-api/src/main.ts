import 'reflect-metadata';
import { ExpressServer, GQLServer, AbstractRestController, AbstractGQLController } from '@saga-soa/api-core';
import { ControllerLoader } from '@saga-soa/api-core/utils/controller-loader';
import { container } from './inversify.config.js';
import type { ILogger } from '@saga-soa/logger';
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

  // Dynamically load all REST controllers
  const restControllers = await controllerLoader.loadControllers(
    path.resolve(__dirname, GLOB_PATTERNS.REST),
    AbstractRestController
  );

  // Get the ExpressServer instance from DI
  const expressServer = container.get(ExpressServer);
  // Initialize and register REST controllers
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
  const gqlServer = container.get(GQLServer);
  await gqlServer.init(container, gqlResolvers);

  // Mount the GraphQL server to the Express app with basePath
  gqlServer.mountToApp(app, '/saga-soa/v1');

  // Add a simple health check (at root level for easy access)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'GraphQL API' });
  });

  // Start the server
  expressServer.start();
}

start().catch(error => {
  const logger = container.get<ILogger>('ILogger');
  logger.error('Failed to start server:', error);
  process.exit(1);
});
