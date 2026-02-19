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
    function createCorsServer(corsAllowedDomains?: string[]) {
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
        ...(corsAllowedDomains !== undefined ? { corsAllowedDomains } : {}),
      };

      container.bind('ExpressServerConfig').toConstantValue(config);
      container.bind('ILogger').toConstantValue(mockLogger);
      container.bind(ExpressServer).toSelf();

      return { container, config, warnings };
    }

    it('no corsAllowedDomains → reflects any origin, credentials: true', async () => {
      const { container, config } = createCorsServer();
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://anything.example.com' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://anything.example.com');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: exact domain match allowed', async () => {
      const { container, config } = createCorsServer(['saga.org']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://saga.org' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://saga.org');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: subdomain match allowed', async () => {
      const { container, config } = createCorsServer(['sagadev.org']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://pr-42.coach.sagadev.org' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://pr-42.coach.sagadev.org');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: non-matching origin rejected (no ACAO header)', async () => {
      const { container, config, warnings } = createCorsServer(['saga.org']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://evil.example.com' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(warnings.some(w => w.includes('evil.example.com'))).toBe(true);
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: no Origin header is always allowed', async () => {
      const { container, config } = createCorsServer(['saga.org']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`);
        expect(res.status).toBe(200);
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: multiple domains', async () => {
      const { container, config } = createCorsServer(['saga.org', 'sagadev.org', 'wootmath.com']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        // Subdomain of first domain
        const r1 = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://coach.saga.org' },
        });
        expect(r1.headers.get('access-control-allow-origin')).toBe('https://coach.saga.org');

        // Subdomain of second domain
        const r2 = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://pr-7.coach.sagadev.org' },
        });
        expect(r2.headers.get('access-control-allow-origin')).toBe('https://pr-7.coach.sagadev.org');

        // Subdomain of third domain
        const r3 = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://staging.wootmath.com' },
        });
        expect(r3.headers.get('access-control-allow-origin')).toBe('https://staging.wootmath.com');

        // Non-matching
        const r4 = await fetch(`http://localhost:${config.port}/simple/`, {
          headers: { Origin: 'https://attacker.com' },
        });
        expect(r4.headers.get('access-control-allow-origin')).toBeNull();
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });

    it('corsAllowedDomains: preflight OPTIONS returns correct headers', async () => {
      const { container, config } = createCorsServer(['saga.org']);
      const server = container.get(ExpressServer);
      await server.init(container, [SimpleTestController]);
      server.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      try {
        const res = await fetch(`http://localhost:${config.port}/simple/`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://coach.saga.org',
            'Access-Control-Request-Method': 'POST',
          },
        });
        expect(res.headers.get('access-control-allow-origin')).toBe('https://coach.saga.org');
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
        expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      } finally {
        server.stop();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
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
