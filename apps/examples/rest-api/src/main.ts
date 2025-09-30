import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { container } from './inversify.config.js';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import { AbstractRestController } from '@hipponot/soa-api-core/abstract-rest-controller';
import type { ILogger } from '@hipponot/soa-logger';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define glob patterns for this API
const GLOB_PATTERNS = {
  REST: './sectors/*.js',
} as const;

async function start() {
  const logger = container.get<ILogger>('ILogger');

  // Get the ControllerLoader from DI
  const controllerLoader = container.get(ControllerLoader);

  // Dynamically load all sector controllers
  const controllers = await controllerLoader.loadControllers(
    path.resolve(__dirname, GLOB_PATTERNS.REST),
    AbstractRestController
  );

  // Start the Express server
  const expressServer = container.get(ExpressServer);
  await expressServer.init(container, controllers);
  const app = expressServer.getApp();

  // Get server config for port info
  const serverConfig = container.get('ExpressServerConfig');

  // Add a simple health check (at root level for easy access)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'REST API', port: serverConfig.port });
  });

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
