import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { TRPCServer } from '@hipponot/soa-api-core/trpc-server';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import { AbstractTRPCController } from '@hipponot/soa-api-core/abstract-trpc-controller';
import { container } from '../src/inversify.config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Enhanced PubSub Integration Tests', () => {
  let app: express.Application;
  let server: any;

  beforeAll(async () => {
    // Get the ControllerLoader from DI
    const controllerLoader = container.get(ControllerLoader);
    
    // Dynamically load all tRPC controllers
    const controllers = await controllerLoader.loadControllers(
      path.resolve(__dirname, '../src/sectors/*/trpc/*-router.ts'),
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
  });

  afterAll(() => {
    if (server) {
      server.close();
    }
  });

  describe('Enhanced PubSub Endpoints', () => {
    it('should have all new pubsub endpoints accessible', async () => {
      // Test ping endpoint
      const pingResponse = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.ping')
        .send({
          message: 'Test ping message',
          timestamp: new Date().toISOString()
        })
        .expect(200);

      expect(pingResponse.body.result.data.success).toBe(true);
      expect(pingResponse.body.result.data.pingEvent).toBeDefined();
      // Note: In the new AbsAction design, actions don't automatically emit events
      // The ping action just returns success, it doesn't emit a pong response

      // Test getEventDefinitions endpoint
      const eventsResponse = await request(app)
        .get('/saga-soa/v1/trpc/pubsub.getEventDefinitions')
        .expect(200);

      expect(eventsResponse.body.result.data.events).toContain('ping:message');
      expect(eventsResponse.body.result.data.events).toContain('pong:response');
      expect(eventsResponse.body.result.data.totalEvents).toBeGreaterThan(0);

      // Test getChannelInfo endpoint
      const channelResponse = await request(app)
        .get('/saga-soa/v1/trpc/pubsub.getChannelInfo')
        .expect(200);

      expect(channelResponse.body.result.data.channel).toBe('pingpong');
      expect(channelResponse.body.result.data.eventTypes).toContain('ping:message');
      expect(channelResponse.body.result.data.eventTypes).toContain('pong:response');

      // Test getServiceStatus endpoint
      const statusResponse = await request(app)
        .get('/saga-soa/v1/trpc/pubsub.getServiceStatus')
        .expect(200);

      expect(statusResponse.body.result.data.status).toBe('running');
      expect(statusResponse.body.result.data.eventsRegistered).toBeGreaterThan(0);
      expect(statusResponse.body.result.data.channels).toContain('pingpong');

      // Test getSubscriptionStats endpoint
      const statsResponse = await request(app)
        .get('/saga-soa/v1/trpc/pubsub.getSubscriptionStats')
        .expect(200);

      expect(statsResponse.body.result.data.connectionStatus).toBe('connected');
      expect(statsResponse.body.result.data.activeChannels).toContain('pingpong');
    });

    it('should handle custom event sending', async () => {
      // Use a valid event name that follows the established pattern
      // Since we only have ping:message and pong:response defined, we'll test with ping:message
      const customEventResponse = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.sendEvent')
        .send({
          name: 'ping:message',
          payload: { message: 'Custom test event', timestamp: new Date().toISOString() },
          channel: 'pingpong',
          options: {
            clientEventId: 'custom-123',
            correlationId: 'corr-456',
            immediate: true
          }
        })
        .expect(200);

      expect(customEventResponse.body.result.data.success).toBe(true);
      expect(customEventResponse.body.result.data.eventId).toBeDefined();
      expect(customEventResponse.body.result.data.message).toContain('Event "ping:message" sent successfully');
    });

    it('should handle subscription management', async () => {
      // Test subscribe endpoint
      const subscribeResponse = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.subscribe')
        .send({
          channel: 'pingpong',
          eventTypes: ['ping:message', 'pong:response']
        })
        .expect(200);

      expect(subscribeResponse.body.result.data.success).toBe(true);
      expect(subscribeResponse.body.result.data.subscriptionId).toBeDefined();
      expect(subscribeResponse.body.result.data.channel).toBe('pingpong');
      expect(subscribeResponse.body.result.data.eventTypes).toEqual(['ping:message', 'pong:response']);

      const subscriptionId = subscribeResponse.body.result.data.subscriptionId;

      // Test unsubscribe endpoint
      const unsubscribeResponse = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.unsubscribe')
        .send({
          subscriptionId
        })
        .expect(200);

      expect(unsubscribeResponse.body.result.data.success).toBe(true);
      expect(unsubscribeResponse.body.result.data.subscriptionId).toBe(subscriptionId);
    });

    it('should validate event name format', async () => {
      // Test invalid event name format - should throw an error
      await request(app)
        .post('/saga-soa/v1/trpc/pubsub.sendEvent')
        .send({
          name: 'invalid-event-name', // Missing colon
          payload: { message: 'Test' }
        })
        .expect(400);
    });

    it('should handle multiple rapid ping operations', async () => {
      const startTime = Date.now();
      const promises = [];

      // Send 5 ping requests rapidly
      for (let i = 0; i < 5; i++) {
        const payload = {
          message: `Rapid ping ${i}`,
          timestamp: new Date().toISOString()
        };

        promises.push(
          request(app)
            .post('/saga-soa/v1/trpc/pubsub.ping')
            .send(payload)
            .expect(200)
        );
      }

      const responses = await Promise.all(promises);
      const endTime = Date.now();

      // All should succeed
      responses.forEach((response, index) => {
        expect(response.body.result.data.success).toBe(true);
        expect(response.body.result.data.pingEvent.payload.message).toBe(`Rapid ping ${index}`);
        // Note: In the new AbsAction design, actions don't automatically emit events
        // The ping action just returns success, it doesn't emit a pong response
      });

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(5000); // 5 seconds
    });

    it('should provide comprehensive ping-pong flow data', async () => {
      const pingPayload = {
        message: 'Comprehensive test message',
        timestamp: new Date().toISOString()
      };

      const response = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.ping')
        .send(pingPayload)
        .expect(200);

      const result = response.body.result.data;

      // Verify ping event structure
      expect(result.pingEvent.id).toBeDefined();
      expect(result.pingEvent.name).toBe('ping:message');
      expect(result.pingEvent.channel).toBe('pingpong');
      expect(result.pingEvent.payload.message).toBe(pingPayload.message);
      // Check that timestamp is close (within 100ms) rather than exact equality
      const payloadTime = new Date(result.pingEvent.payload.timestamp).getTime();
      const expectedTime = new Date(pingPayload.timestamp).getTime();
      expect(Math.abs(payloadTime - expectedTime)).toBeLessThan(100);
      expect(result.pingEvent.timestamp).toBeDefined();

      // Note: In the new AbsAction design, actions don't automatically emit events
      // The ping action just returns success, it doesn't emit a pong response
      // The pong response would need to be triggered separately if needed

      // Verify overall response
      expect(result.success).toBe(true);
      expect(result.message).toContain('Ping sent successfully');
      expect(result.pubsubResult).toBeDefined();
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid ping payloads gracefully', async () => {
      const invalidPayloads = [
        {}, // Empty payload
        { message: '' }, // Empty message
        { message: null }, // Null message
        { timestamp: 'invalid-timestamp' } // Invalid timestamp
      ];

      for (const payload of invalidPayloads) {
        await request(app)
          .post('/saga-soa/v1/trpc/pubsub.ping')
          .send(payload)
          .expect(400);
      }
    });

    it('should handle malformed subscription requests', async () => {
      // Test invalid subscription data - should throw an error
      await request(app)
        .post('/saga-soa/v1/trpc/pubsub.subscribe')
        .send({
          // Missing required channel
          eventTypes: ['ping:message']
        })
        .expect(400);
    });

    it('should handle unsubscribe with invalid subscription ID', async () => {
      const response = await request(app)
        .post('/saga-soa/v1/trpc/pubsub.unsubscribe')
        .send({
          subscriptionId: 'non-existent-id'
        })
        .expect(200);

      expect(response.body.result.data.success).toBe(true);
    });
  });

  describe('Performance and Scalability', () => {
    it('should handle concurrent ping operations', async () => {
      const concurrentCount = 10;
      const startTime = Date.now();
      
      const promises = Array.from({ length: concurrentCount }, (_, i) => 
        request(app)
          .post('/saga-soa/v1/trpc/pubsub.ping')
          .send({
            message: `Concurrent ping ${i}`,
            timestamp: new Date().toISOString()
          })
          .expect(200)
      );

      const responses = await Promise.all(promises);
      const endTime = Date.now();

      // All should succeed
      responses.forEach((response, index) => {
        expect(response.body.result.data.success).toBe(true);
        expect(response.body.result.data.pingEvent.payload.message).toBe(`Concurrent ping ${index}`);
      });

      // Should complete within reasonable time
      expect(endTime - startTime).toBeLessThan(10000); // 10 seconds
      expect(responses).toHaveLength(concurrentCount);
    });

    it('should maintain consistent response structure under load', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          request(app)
            .post('/saga-soa/v1/trpc/pubsub.ping')
            .send({
              message: `Load test ${i}`,
              timestamp: new Date().toISOString()
            })
            .expect(200)
        )
      );

      // Verify consistent structure across all responses
      responses.forEach(response => {
        const data = response.body.result.data;
        expect(data).toHaveProperty('success');
        expect(data).toHaveProperty('pingEvent');
        // Note: In the new AbsAction design, actions don't automatically emit events
        // The ping action just returns success, it doesn't emit a pong response
        expect(data).toHaveProperty('message');
        expect(data).toHaveProperty('pubsubResult');
        
        // Verify nested structure consistency
        expect(data.pingEvent).toHaveProperty('id');
        expect(data.pingEvent).toHaveProperty('name');
        expect(data.pingEvent).toHaveProperty('channel');
        expect(data.pingEvent).toHaveProperty('payload');
        expect(data.pingEvent).toHaveProperty('timestamp');
      });
    });
  });
});
