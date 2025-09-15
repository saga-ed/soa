import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { injectable, inject } from 'inversify';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import type { ILogger } from '@hipponot/soa-logger';
import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { TRPCServer } from '@hipponot/soa-api-core/trpc-server';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import { AbstractTRPCController } from '@hipponot/soa-api-core/abstract-trpc-controller';
import type { TRPCServerConfig } from '@hipponot/soa-api-core/trpc-server-schema';
import { container } from '../inversify.config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('tRPC API Integration Tests', () => {
  let app: express.Application;
  let client: any;
  let server: any;

  beforeAll(async () => {
    // Get the ControllerLoader from DI
    const controllerLoader = container.get(ControllerLoader);
    
    // Dynamically load all tRPC controllers
    const controllers = await controllerLoader.loadControllers(
      path.resolve(__dirname, '../sectors/*/trpc/*-router.ts'),
      AbstractTRPCController
    );

    console.log(
      'Loaded tRPC controllers:',
      controllers.map((c: any) => c.name)
    );

    // Bind all loaded controllers to the DI container
    for (const controller of controllers) {
      container.bind(controller).toSelf().inSingletonScope();
    }

    // Configure Express server
    const expressServer = container.get(ExpressServer);
    await expressServer.init(container, []);
    app = expressServer.getApp();

    // Get the TRPCServer instance from DI
    const trpcServer = container.get(TRPCServer);

    // Add routers to the TRPCServer using dynamically loaded controllers
    for (const controller of controllers) {
      const controllerInstance = container.get(controller) as any;
      trpcServer.addRouter(controllerInstance.sectorName, controllerInstance.createRouter());
    }

    // Create tRPC middleware using TRPCServer
    const trpcMiddleware = trpcServer.createExpressMiddleware();

    // Mount tRPC on the configured base path
    app.use(trpcServer.getBasePath(), trpcMiddleware);

    // Start the server on a random port
    server = app.listen(0);
    const port = (server.address() as any).port;

    // Create tRPC client
    client = createTRPCProxyClient({
      links: [
        httpBatchLink({
          url: `http://localhost:${port}${trpcServer.getBasePath()}`,
        }),
      ],
    });
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  describe('Project Router', () => {
    it('should get all projects', async () => {
      const result = await client.project.getAllProjects.query();
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(Array.isArray(result)).toBe(true);
    });

    it('should get project by ID', async () => {
      const result = await client.project.getProjectById.query({ id: '1' });
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(result.id).toBe('1');
      expect(result.name).toBe('Saga SOA Platform');
    });

    it('should create a new project', async () => {
      const newProject = {
        name: 'Test Project',
        description: 'A test project',
        status: 'active' as const,
      };

      console.log('Request input:', JSON.stringify(newProject, null, 2));
      const result = await client.project.createProject.mutate(newProject);
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(result.name).toBe(newProject.name);
      expect(result.description).toBe(newProject.description);
    });
  });

  describe('Run Router', () => {
    it('should get all runs', async () => {
      const result = await client.run.getAllRuns.query();
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(Array.isArray(result)).toBe(true);
    });

    it('should get run by ID', async () => {
      const result = await client.run.getRunById.query({ id: '1' });
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(result.id).toBe('1');
      expect(result.name).toBe('Initial Build');
    });

    it('should create a new run', async () => {
      const newRun = {
        projectId: '1',
        name: 'Test Run',
        description: 'A test run',
        status: 'pending' as const,
      };

      console.log('Request input:', JSON.stringify(newRun, null, 2));
      const result = await client.run.createRun.mutate(newRun);
      console.log('Result:', JSON.stringify(result, null, 2));
      expect(result.name).toBe(newRun.name);
      expect(result.projectId).toBe(newRun.projectId);
    });
  });
});
