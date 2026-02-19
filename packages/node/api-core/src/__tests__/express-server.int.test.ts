import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import type { Request, Response } from 'express';
import { injectable, inject, Container } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { TestSector } from './test-sector.js';
import { fetch } from 'undici';
import { useContainer, createExpressServer } from 'routing-controllers';
import { ExpressServer } from '../express-server.js';
import { JsonController, Get } from 'routing-controllers';

function getRandomPort() {
  return Math.floor(Math.random() * 10000) + 20000;
}

// Simple test controller for basePath testing
@injectable()
@JsonController('/simple')
export class SimpleTestController {
  @Get('/')
  getSimple() {
    return { message: 'simple test' };
  }
}

describe('ExpressServer (integration)', () => {
  it('should start and stop correctly', async () => {
    const container = new Container();
    const mockLogger: ILogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const config = {
      configType: 'EXPRESS_SERVER' as const,
      port: getRandomPort(),
      logLevel: 'info' as const,
      name: 'Test Server',
    };

    container.bind('ExpressServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(ExpressServer).toSelf();

    const server = container.get(ExpressServer);
    await server.init(container, [TestSector]);

    // Start the server
    server.start();

    // Wait a bit for server to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Stop the server
    server.stop();

    // Wait a bit for server to stop
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  it('should work with basePath using routing-controllers directly', async () => {
    // Test the basePath functionality using routing-controllers directly
    const container = new Container();
    container.bind(TestSector).toSelf();
    useContainer(container);

    const app = createExpressServer({
      controllers: [TestSector],
      routePrefix: '/api/v1',
    });

    const port = getRandomPort();
    const server = app.listen(port);

    try {
      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test the basePath route
      const response = await fetch(`http://localhost:${port}/api/v1/test/`);
      expect(response.status).toBe(200);

      // Test that routes without basePath are not accessible
      const responseWithoutBasePath = await fetch(`http://localhost:${port}/test/`);
      expect(responseWithoutBasePath.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('should work without basePath using routing-controllers directly', async () => {
    // Test without basePath using routing-controllers directly
    const container = new Container();
    container.bind(TestSector).toSelf();
    useContainer(container);

    const app = createExpressServer({
      controllers: [TestSector],
      // No routePrefix
    });

    const port = getRandomPort();
    const server = app.listen(port);

    try {
      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test the direct route
      const response = await fetch(`http://localhost:${port}/test/`);
      expect(response.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('should work with basePath using ExpressServer', async () => {
    const container = new Container();
    const mockLogger: ILogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const config = {
      configType: 'EXPRESS_SERVER' as const,
      port: getRandomPort(),
      logLevel: 'info' as const,
      name: 'Test Server with BasePath',
      basePath: '/api/v1',
    };

    container.bind('ExpressServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(ExpressServer).toSelf();

    const server = container.get(ExpressServer);
    // Use SimpleTestController instead of TestSector to avoid SectorsController interference
    await server.init(container, [SimpleTestController]);

    // Start the server
    server.start();

    // Wait a bit for server to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Test that routes are accessible with basePath
    const port = config.port;

    // Test the basePath route
    const response = await fetch(`http://localhost:${port}/api/v1/simple/`);
    expect(response.status).toBe(200);

    // Test that routes without basePath are not accessible
    const responseWithoutBasePath = await fetch(`http://localhost:${port}/simple/`);
    expect(responseWithoutBasePath.status).toBe(404);

    // Stop the server
    server.stop();

    // Wait a bit for server to stop
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('CORS: subdomain-aware origin validation', () => {
    /** Starts a CORS-configured server, runs the callback, then cleans up. */
    async function withCorsServer(
      domains: string[] | undefined,
      fn: (port: number, warnings: string[]) => Promise<void>,
    ) {
      const container = new Container();
      const warnings: string[] = [];
      const mockLogger: ILogger = {
        info: () => {},
        warn: (msg: string) => { warnings.push(msg); },
        error: () => {},
        debug: () => {},
      };

      const config = {
        configType: 'EXPRESS_SERVER' as const,
        port: getRandomPort(),
        logLevel: 'info' as const,
        name: 'CORS Test Server',
        ...(domains !== undefined ? { corsAllowedDomains: domains } : {}),
      };

      container.bind('ExpressServerConfig').toConstantValue(config);
      container.bind('ILogger').toConstantValue(mockLogger);
      container.bind(ExpressServer).toSelf();

      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        await fn(config.port, warnings);
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    it('no corsAllowedDomains → reflects any origin, credentials: true', async () => {
      await withCorsServer(undefined, async (port) => {
        const res = await fetch(`http://localhost:${port}/simple/`, {
          headers: { Origin: 'https://anything.example.com' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://anything.example.com');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      });
    });

    it.each([
      { origin: 'https://saga.org',                  domains: ['saga.org'],    desc: 'exact domain match' },
      { origin: 'https://pr-42.coach.sagadev.org',   domains: ['sagadev.org'], desc: 'subdomain match' },
      { origin: 'https://coach.saga.org',             domains: ['saga.org', 'sagadev.org', 'wootmath.com'], desc: 'first of multiple domains' },
      { origin: 'https://pr-7.coach.sagadev.org',     domains: ['saga.org', 'sagadev.org', 'wootmath.com'], desc: 'second of multiple domains' },
      { origin: 'https://staging.wootmath.com',        domains: ['saga.org', 'sagadev.org', 'wootmath.com'], desc: 'third of multiple domains' },
    ])('allows $desc ($origin)', async ({ origin, domains }) => {
      await withCorsServer(domains, async (port) => {
        const res = await fetch(`http://localhost:${port}/simple/`, {
          headers: { Origin: origin },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      });
    });

    it('rejects non-matching origin (no ACAO header, logs warning)', async () => {
      await withCorsServer(['saga.org'], async (port, warnings) => {
        const res = await fetch(`http://localhost:${port}/simple/`, {
          headers: { Origin: 'https://evil.example.com' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(warnings).toEqual(
          expect.arrayContaining([expect.stringContaining('evil.example.com')]),
        );
      });
    });

    it('no Origin header is always allowed', async () => {
      await withCorsServer(['saga.org'], async (port) => {
        const res = await fetch(`http://localhost:${port}/simple/`);
        expect(res.status).toBe(200);
      });
    });

    it('preflight OPTIONS returns correct headers', async () => {
      await withCorsServer(['saga.org'], async (port) => {
        const res = await fetch(`http://localhost:${port}/simple/`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://coach.saga.org',
            'Access-Control-Request-Method': 'POST',
          },
        });
        expect(res.headers.get('access-control-allow-origin')).toBe('https://coach.saga.org');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
        expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      });
    });
  });

  it('should work without basePath using ExpressServer (backward compatibility)', async () => {
    const container = new Container();
    const mockLogger: ILogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const config = {
      configType: 'EXPRESS_SERVER' as const,
      port: getRandomPort(),
      logLevel: 'info' as const,
      name: 'Test Server without BasePath',
      // No basePath specified
    };

    container.bind('ExpressServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(ExpressServer).toSelf();

    const server = container.get(ExpressServer);
    // Use SimpleTestController instead of TestSector to avoid SectorsController interference
    await server.init(container, [SimpleTestController]);

    // Start the server
    server.start();

    // Wait a bit for server to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Test that routes are accessible without basePath
    const port = config.port;

    // Test the direct route
    const response = await fetch(`http://localhost:${port}/simple/`);
    expect(response.status).toBe(200);

    // Stop the server
    server.stop();

    // Wait a bit for server to stop
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
