import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { TRPCServer } from '../trpc-server.js';
import { TRPCServerSchema } from '../trpc-server-schema.js';
import { MockLogger } from '@hipponot/soa-logger/mocks';

describe('TRPCServer', () => {
  let container: Container;
  let trpcServer: TRPCServer;

  beforeEach(() => {
    container = new Container();

    const config = TRPCServerSchema.parse({
      configType: 'TRPC_SERVER',
      name: 'Test tRPC Server',
      basePath: '/api/trpc',
    });

    container.bind('TRPCServerConfig').toConstantValue(config);
    container.bind('ILogger').to(MockLogger);
    container.bind(TRPCServer).toSelf();

    trpcServer = container.get(TRPCServer);
  });

  describe('initialization', () => {
    it('should create a tRPC instance', () => {
      expect(trpcServer.getTRPC()).toBeDefined();
      expect(trpcServer.procedures).toBeDefined();
      expect(trpcServer.router).toBeDefined();
    });

    it('should have correct configuration', () => {
      expect(trpcServer.getName()).toBe('Test tRPC Server');
      expect(trpcServer.getBasePath()).toBe('/api/trpc');
    });
  });

  describe('router management', () => {
    it('should start with no routers', () => {
      expect(trpcServer.getRouterNames()).toEqual([]);
      expect(trpcServer.hasRouter('test')).toBe(false);
    });

    it('should add a single router', () => {
      const testRouter = trpcServer.router({
        hello: trpcServer.procedures.query(() => 'world'),
      });

      trpcServer.addRouter('test', testRouter);

      expect(trpcServer.getRouterNames()).toEqual(['test']);
      expect(trpcServer.hasRouter('test')).toBe(true);
    });

    it('should add multiple routers', () => {
      const router1 = trpcServer.router({
        hello: trpcServer.procedures.query(() => 'world'),
      });

      const router2 = trpcServer.router({
        goodbye: trpcServer.procedures.query(() => 'bye'),
      });

      trpcServer.addRouters({
        test1: router1,
        test2: router2,
      });

      expect(trpcServer.getRouterNames()).toEqual(['test1', 'test2']);
      expect(trpcServer.hasRouter('test1')).toBe(true);
      expect(trpcServer.hasRouter('test2')).toBe(true);
    });

    it('should remove a router', () => {
      const testRouter = trpcServer.router({
        hello: trpcServer.procedures.query(() => 'world'),
      });

      trpcServer.addRouter('test', testRouter);
      expect(trpcServer.hasRouter('test')).toBe(true);

      const removed = trpcServer.removeRouter('test');
      expect(removed).toBe(true);
      expect(trpcServer.hasRouter('test')).toBe(false);
    });

    it('should clear all routers', () => {
      const router1 = trpcServer.router({
        hello: trpcServer.procedures.query(() => 'world'),
      });

      const router2 = trpcServer.router({
        goodbye: trpcServer.procedures.query(() => 'bye'),
      });

      trpcServer.addRouters({
        test1: router1,
        test2: router2,
      });

      expect(trpcServer.getRouterNames()).toHaveLength(2);

      trpcServer.clearRouters();
      expect(trpcServer.getRouterNames()).toEqual([]);
    });
  });

  describe('merged router', () => {
    it('should create an empty router when no routers are added', () => {
      const mergedRouter = trpcServer.getRouter();
      expect(mergedRouter).toBeDefined();
    });

    it('should merge multiple routers', () => {
      const router1 = trpcServer.router({
        hello: trpcServer.procedures.query(() => 'world'),
      });

      const router2 = trpcServer.router({
        goodbye: trpcServer.procedures.query(() => 'bye'),
      });

      trpcServer.addRouters({
        test1: router1,
        test2: router2,
      });

      const mergedRouter = trpcServer.getRouter();
      expect(mergedRouter).toBeDefined();
      expect(mergedRouter._def.record).toBeDefined();
    });
  });

  describe('Express middleware', () => {
    it('should create Express middleware', () => {
      const middleware = trpcServer.createExpressMiddleware();
      expect(middleware).toBeDefined();
      expect(typeof middleware).toBe('function');
    });
  });
});
