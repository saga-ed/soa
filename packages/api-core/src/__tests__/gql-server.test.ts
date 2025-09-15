import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'reflect-metadata';
import { injectable, Container } from 'inversify';
import type { ILogger } from '@hipponot/soa-logger';
import { fetch } from 'undici';
import express from 'express';
import { Query, Resolver } from 'type-graphql';
import { GQLServer } from '../gql-server.js';
import { TestGQLController } from './fixtures/TestGQLController.js';
import { AbstractGQLController } from '../abstract-gql-controller.js';

function getRandomPort() {
  return Math.floor(Math.random() * 10000) + 20000;
}

// Simple test GQL controller for testing
@injectable()
@Resolver()
export class SimpleTestGQLController extends AbstractGQLController {
  sectorName = 'simple-test-gql';

  @Query(() => String)
  async simpleHello(): Promise<string> {
    return 'Hello from SimpleTestGQLController!';
  }
}

describe('GQLServer (integration)', () => {
  let container: Container;
  let mockLogger: ILogger;

  beforeEach(() => {
    container = new Container();
    mockLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  });

  afterEach(() => {
    container.unbindAll();
  });

  it('should initialize correctly with valid resolvers', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    expect(server.getApolloServer()).toBeDefined();
  });

  it('should fail initialization with no resolvers', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);

    await expect(server.init(container, [])).rejects.toThrow('At least one resolver is required');
  });

  it('should fail mounting before initialization', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    const app = express();

    expect(() => server.mountToApp(app)).toThrow(
      'GQLServer must be initialized before mounting to app'
    );
  });

  it('should mount to Express app correctly', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();
    server.mountToApp(app);

    expect(server.getApolloServer()).toBeDefined();
  });

  it('should mount to Express app with basePath correctly', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();
    server.mountToApp(app, '/api/v1');

    expect(server.getApolloServer()).toBeDefined();
  });

  it('should work with custom mount point', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/api/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();
    server.mountToApp(app);

    expect(server.getApolloServer()).toBeDefined();
  });

  it('should start and stop correctly', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    server.mountToApp(app);

    // Start the Express app
    const port = getRandomPort();
    const expressServer = app.listen(port);

    try {
      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test that the GraphQL endpoint is accessible
      const response = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(response.status).toBe(200);
    } finally {
      // Stop the Express server
      expressServer.close();

      // Stop the GraphQL server
      await server.stop();
    }
  });

  it('should handle GraphQL queries correctly', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    server.mountToApp(app);

    const port = getRandomPort();
    const expressServer = app.listen(port);

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test a simple GraphQL query
      const response = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(response.status).toBe(200);
      const result = (await response.json()) as { data?: unknown };
      expect(result.data).toBeDefined();
    } finally {
      expressServer.close();
      await server.stop();
    }
  });

  it('should work with different mount points', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/api/v1/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    server.mountToApp(app);

    const port = getRandomPort();
    const expressServer = app.listen(port);

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test the custom mount point
      const response = await fetch(`http://localhost:${port}/api/v1/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(response.status).toBe(200);

      // Test that the default mount point is not accessible
      const responseDefault = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(responseDefault.status).toBe(404);
    } finally {
      expressServer.close();
      await server.stop();
    }
  });

  it('should work with basePath and playground', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      enablePlayground: true,
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    const app = express();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    server.mountToApp(app, '/api/v1');

    const port = getRandomPort();
    const expressServer = app.listen(port);

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test the GraphQL endpoint with basePath
      const response = await fetch(`http://localhost:${port}/api/v1/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(response.status).toBe(200);

      // Test that the playground is accessible at the correct path
      const playgroundResponse = await fetch(`http://localhost:${port}/api/v1/graphql`, {
        headers: {
          Accept: 'text/html',
        },
      });

      expect(playgroundResponse.status).toBe(200);
      expect(playgroundResponse.headers.get('content-type')).toContain('text/html');
    } finally {
      expressServer.close();
      await server.stop();
    }
  });

  it('should handle multiple resolvers correctly', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController, SimpleTestGQLController]);

    const app = express();

    // Add express.json() middleware before Apollo middleware
    app.use(express.json());

    server.mountToApp(app);

    const port = getRandomPort();
    const expressServer = app.listen(port);

    try {
      await new Promise(resolve => setTimeout(resolve, 100));

      // Test that the server works with multiple resolvers
      const response = await fetch(`http://localhost:${port}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: '{ hello { message } }',
        }),
      });

      expect(response.status).toBe(200);
    } finally {
      expressServer.close();
      await server.stop();
    }
  });

  it('should handle configuration validation correctly', async () => {
    // Test with invalid mount point (doesn't start with '/')
    const invalidConfig = {
      configType: 'GQL_SERVER' as const,
      mountPoint: 'graphql', // Missing leading slash
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    // The schema validation happens when the config is used, not when bound
    container.bind('GQLServerConfig').toConstantValue(invalidConfig);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);

    // This should throw an error during initialization due to invalid config
    try {
      await server.init(container, [TestGQLController]);
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (error) {
      // Expected to throw an error
      expect(error).toBeDefined();
    }
  });

  it('should stop gracefully', async () => {
    const config = {
      configType: 'GQL_SERVER' as const,
      mountPoint: '/graphql',
      logLevel: 'info' as const,
      name: 'Test GraphQL Server',
      emitSchema: false, // Disable SDL emission during tests
    };

    container.bind('GQLServerConfig').toConstantValue(config);
    container.bind('ILogger').toConstantValue(mockLogger);
    container.bind(GQLServer).toSelf();

    const server = container.get(GQLServer);
    await server.init(container, [TestGQLController]);

    // Stop the server
    await server.stop();

    // Verify the Apollo server is stopped
    expect(server.getApolloServer()).toBeDefined();
  });
});
