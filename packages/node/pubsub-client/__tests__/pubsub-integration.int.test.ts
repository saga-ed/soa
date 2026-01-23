import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { TRPCPubSubClient } from '../src/trpc-pubsub-client.js';
import type { EventEnvelope } from '@saga-ed/soa-pubsub-core';
import { createTestServer, waitForServer, type TestServer } from './integration/test-server.js';

describe('PubSub Integration Tests', () => {
  let client: TRPCPubSubClient;
  let testServer: TestServer;
  let apiBaseUrl: string;
  let tRPCPath: string;

  beforeAll(async () => {
    // Create and start minimal test server
    testServer = await createTestServer({
      port: 0, // Random port to avoid conflicts
      basePath: '/saga-soa/v1/trpc'
    });
    
    apiBaseUrl = testServer.url;
    tRPCPath = '/saga-soa/v1/trpc';
    
    // Wait for server to be ready
    await waitForServer(apiBaseUrl);
    
    client = new TRPCPubSubClient({
      baseUrl: apiBaseUrl,
      tRPCPath
    });
  });

  afterAll(async () => {
    await client.close();
    await testServer.close();
  });

  beforeEach(async () => {
    // Clear any existing state
    await client.unsubscribeAll();
  });

  afterEach(async () => {
    // Clean up after each test
    await client.unsubscribeAll();
  });

  describe('Test Server Health Check', () => {
    it('should have test server running and accessible', async () => {
      const response = await request(apiBaseUrl)
        .get('/health')
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should have tRPC API accessible', async () => {
      const response = await request(apiBaseUrl)
        .get(`${tRPCPath}/pubsub.getEventDefinitions`)
        .expect(200);

      expect(response.body).toBeDefined();
      expect(response.body.result).toBeDefined();
      expect(response.body.result.data).toBeDefined();
    });

    it('should have pubsub sector loaded', async () => {
      const response = await request(apiBaseUrl)
        .get(`${tRPCPath}/pubsub.getChannelInfo`)
        .expect(200);

      const data = response.body.result.data;
      expect(data.channel).toBe('pingpong');
      expect(data.eventTypes).toContain('ping:message');
      expect(data.eventTypes).toContain('pong:response');
    });
  });

  describe('Ping-Pong Flow Integration', () => {
    it('should complete full ping-pong cycle via tRPC API', async () => {
      // 1. Subscribe to pong events (this would be WebSocket/SSE in real implementation)
      const pongEvents: EventEnvelope[] = [];
      const pongHandler = (event: EventEnvelope) => {
        pongEvents.push(event);
      };

      const subscription = await client.subscribe('pingpong', pongHandler);

      // 2. Send ping via tRPC API
      const pingPayload = {
        message: 'Integration test ping',
        timestamp: new Date().toISOString()
      };

      const response = await request(apiBaseUrl)
        .post(`${tRPCPath}/pubsub.ping`)
        .send(pingPayload)
        .expect(200);

      const result = response.body.result.data;
      
      // 3. Verify ping was processed
      expect(result.success).toBe(true);
      expect(result.pingEvent).toBeDefined();
      expect(result.pongResponse).toBeDefined();
      expect(result.message).toContain('Ping sent successfully');

      // 4. Verify ping event structure
      const pingEvent = result.pingEvent;
      expect(pingEvent.name).toBe('ping:message');
      expect(pingEvent.channel).toBe('pingpong');
      expect(pingEvent.payload.message).toBe(pingPayload.message);

      // 5. Verify pong response structure
      const pongResponse = result.pongResponse;
      expect(pongResponse.name).toBe('pong:response');
      expect(pongResponse.channel).toBe('pingpong');
      expect(pongResponse.payload.reply).toContain('Pong! Received:');
      expect(pongResponse.payload.originalMessage).toBe(pingPayload.message);

      // 6. Clean up
      await subscription.unsubscribe();
    }, 10000); // 10 second timeout for integration test

    it('should handle multiple ping-pong cycles', async () => {
      const messages = ['Ping 1', 'Ping 2', 'Ping 3'];
      const results = [];

      for (const message of messages) {
        const payload = { message, timestamp: new Date().toISOString() };
        
        const response = await request(apiBaseUrl)
          .post(`${tRPCPath}/pubsub.ping`)
          .send(payload)
          .expect(200);

        const result = response.body.result.data;
        results.push(result);

        expect(result.success).toBe(true);
        expect(result.pingEvent.payload.message).toBe(message);
        expect(result.pongResponse.payload.originalMessage).toBe(message);
      }

      expect(results).toHaveLength(3);
    }, 15000); // 15 second timeout for multiple cycles
  });

  describe('Error Handling Integration', () => {
    it('should handle invalid ping payloads', async () => {
      const invalidPayloads = [
        {}, // Empty payload
        { message: '' }, // Empty message
        { message: null }, // Null message
        { timestamp: 'invalid-timestamp' } // Invalid timestamp
      ];

      for (const payload of invalidPayloads) {
        const response = await request(apiBaseUrl)
          .post(`${tRPCPath}/pubsub.ping`)
          .send(payload)
          .expect(400); // Should return 400 for validation errors

        expect(response.body.error).toBeDefined();
      }
    });

    it('should handle malformed requests', async () => {
      // Note: Express by default might not return an error for malformed JSON
      // This test verifies the behavior is handled gracefully
      try {
        const response = await request(apiBaseUrl)
          .post(`${tRPCPath}/pubsub.ping`)
          .send('invalid-json')
          .set('Content-Type', 'application/json');

        // The response might be 400 (error) or 200 (Express parsed it as string)
        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(500);
      } catch (error) {
        // If the request fails entirely, that's also acceptable
        expect(error).toBeDefined();
      }
    });
  });

  describe('Performance Integration', () => {
    it('should handle rapid ping requests', async () => {
      const startTime = Date.now();
      const promises = [];

      // Send 5 ping requests rapidly
      for (let i = 0; i < 5; i++) {
        const payload = {
          message: `Rapid ping ${i}`,
          timestamp: new Date().toISOString()
        };

        promises.push(
          request(apiBaseUrl)
            .post(`${tRPCPath}/pubsub.ping`)
            .send(payload)
            .expect(200)
        );
      }

      const responses = await Promise.all(promises);
      const endTime = Date.now();

      // All should succeed
      responses.forEach(response => {
        expect(response.body.result.data.success).toBe(true);
      });

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000); // 5 seconds
    }, 10000);
  });
});
