import express, { Application } from 'express';
import cors from 'cors';
import { injectable, inject } from 'inversify';
import type { ExpressServerConfig } from './express-server-schema.js';
import type { ILogger } from '@saga-ed/soa-logger';
import { useContainer, useExpressServer } from 'routing-controllers';
import { Container } from 'inversify';
import { SectorsController } from './sectors-controller.js';

@injectable()
export class ExpressServer {
  private readonly app: Application;
  private serverInstance?: ReturnType<Application['listen']>;

  constructor(
    @inject('ExpressServerConfig') private config: ExpressServerConfig,
    @inject('ILogger') private logger: ILogger
  ) {
    this.app = express();
  }

  public async init(
    container: Container,
    controllers: Array<new (...args: any[]) => any>
  ): Promise<void> {
    // Add CORS middleware to allow tRPC playground requests
    this.app.use(cors({
      origin: true, // Allow all origins for development
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }));

    // Ensure routing-controllers uses Inversify for controller resolution
    useContainer(container);

    // Always add SectorsController to the list
    const controllerClasses = [...controllers, SectorsController].filter(
      (ctrl): ctrl is new (...args: any[]) => any => typeof ctrl === 'function'
    );

    // Step 1: Register all controllers with the DI container
    for (const ControllerClass of controllerClasses) {
      container.bind(ControllerClass).toSelf().inSingletonScope();
    }

    // Step 2: Instantiate and initialize all controllers
    for (const ControllerClass of controllerClasses) {
      // Instantiate the controller (resolving all async dependencies)
      const controllerInstance = await container.getAsync<any>(ControllerClass);
      // If the controller has an async init method, call it now
      if (typeof controllerInstance.init === 'function') {
        await controllerInstance.init();
      }
    }

    // Prepare routing-controllers configuration
    const routingConfig: Parameters<typeof useExpressServer>[1] = {
      controllers: controllerClasses as Function[],
    };

    // Add routePrefix if basePath is configured
    if (this.config.basePath) {
      routingConfig.routePrefix = this.config.basePath;
    }

    // Register controller classes with routing-controllers
    useExpressServer(this.app, routingConfig);
  }

  public start(): void {
    this.serverInstance = this.app.listen(this.config.port, () => {
      const basePathInfo = this.config.basePath ? ` with basePath '${this.config.basePath}'` : '';
      this.logger.info(
        `Express server '${this.config.name}' started on port ${this.config.port}${basePathInfo}`
      );
    });
  }

  public stop(): void {
    if (this.serverInstance) {
      this.serverInstance.close(() => {
        this.logger.info(`Express server '${this.config.name}' stopped.`);
      });
    }
  }

  public getApp(): Application {
    return this.app;
  }
}
