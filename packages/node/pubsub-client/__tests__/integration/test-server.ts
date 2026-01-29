import express from 'express';
import { z } from 'zod';

// Define ping message schema
const PingMessageSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty'),
  timestamp: z.string()
});

type PingMessageInput = z.infer<typeof PingMessageSchema>;

// Test server configuration
export interface TestServerConfig {
  port?: number;
  basePath?: string;
}

// Test server instance
export interface TestServer {
  url: string;
  port: number;
  app: express.Application;
  close: () => Promise<void>;
}

/**
 * Create a minimal test server with pubsub functionality
 */
export async function createTestServer(config: TestServerConfig = {}): Promise<TestServer> {
  const { port = 0, basePath = '/saga-soa/v1/trpc' } = config;

  // Create Express app
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // PubSub endpoints
  app.post(`${basePath}/pubsub.ping`, (req, res) => {
    try {
      // Validate input
      const input = PingMessageSchema.parse(req.body);
      
      // Create ping event envelope
      const pingEnvelope = {
        id: crypto.randomUUID(),
        name: 'ping:message' as const,
        channel: 'pingpong' as const,
        payload: {
          message: input.message,
          timestamp: input.timestamp
        },
        timestamp: new Date().toISOString()
      };

      // Simulate pubsub service call
      const pongResponse = {
        id: crypto.randomUUID(),
        name: 'pong:response' as const,
        channel: 'pingpong' as const,
        payload: {
          reply: `Pong! Received: ${input.message}`,
          originalMessage: input.message,
          timestamp: new Date().toISOString()
        },
        timestamp: new Date().toISOString()
      };

      res.json({
        result: {
          data: {
            success: true,
            pingEvent: pingEnvelope,
            pongResponse,
            message: `Ping sent successfully: "${input.message}"`
          }
        }
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Validation failed'
      });
    }
  });

  app.get(`${basePath}/pubsub.getEventDefinitions`, (req, res) => {
    res.json({
      result: {
        data: {
          events: ['ping:message', 'pong:response'],
          pingEvent: { name: 'ping:message', channel: 'pingpong' },
          pongEvent: { name: 'pong:response', channel: 'pingpong' }
        }
      }
    });
  });

  app.get(`${basePath}/pubsub.getChannelInfo`, (req, res) => {
    res.json({
      result: {
        data: {
          channel: 'pingpong',
          eventTypes: ['ping:message', 'pong:response'],
          description: 'Ping-pong demonstration channel for CSE/SSE testing'
        }
      }
    });
  });

  // Start server
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === 'string' ? 0 : address?.port || 0;
      
      resolve({
        url: `http://localhost:${actualPort}`,
        port: actualPort,
        app,
        close: () => new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        })
      });
    });

    server.on('error', reject);
  });
}

/**
 * Wait for server to be ready
 */
export async function waitForServer(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        return; // Server is ready
      }
    } catch (error) {
      // Server not ready yet, wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  throw new Error(`Server not ready after ${maxAttempts} attempts`);
}
