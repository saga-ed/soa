import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ExpressServer } from '@saga-ed/soa-api-core/express-server';
import { ControllerLoader } from '@saga-ed/soa-api-core/utils/controller-loader';
import { AbstractRestController } from '@saga-ed/soa-api-core/abstract-rest-controller';
import { container } from '../inversify.config.js';
import express from 'express';

let app: express.Application;

beforeAll(async () => {
  // Dynamically load all sector controllers (match main.ts logic)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  
  // Get the ControllerLoader from DI
  const controllerLoader = container.get(ControllerLoader);
  
  const controllers = await controllerLoader.loadControllers(
    // Note this is a vitest so we load the TS files - vitest uses esbuild to transpile ts files on the fly for testing
    path.resolve(__dirname, '../sectors/*.ts'),
    AbstractRestController
  );
  console.log(
    'Loaded controllers:',
    controllers.map((c: any) => c.name)
  );

  // Use ExpressServer from DI, initialize with controllers, and get the app instance
  const expressServer = container.get(ExpressServer);
  await expressServer.init(container, controllers);
  app = expressServer.getApp();
});

describe('REST API Integration', () => {
  it('GET /saga-soa/hello/test-route', async () => {
    const res = await request(app).get('/saga-soa/hello/test-route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hello');
  });

  it('GET /saga-soa/hello-again/test-route', async () => {
    const res = await request(app).get('/saga-soa/hello-again/test-route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hello Again');
  });

  it('GET /saga-soa/hello-mongo/test-route', async () => {
    const res = await request(app).get('/saga-soa/hello-mongo/test-route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hello Mongo');
  });
});
