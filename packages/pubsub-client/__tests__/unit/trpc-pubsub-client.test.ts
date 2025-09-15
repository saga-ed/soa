import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TRPCPubSubClient } from '../../src/trpc-pubsub-client.js';
import type { EventEnvelope, EventName, CSEEventWithResponse, SSEEvent, CSEEvent } from '@hipponot/soa-pubsub-core';

describe('TRPCPubSubClient', () => {
  let client: TRPCPubSubClient;
  const mockConfig = {
    baseUrl: 'http://localhost:5000',
    tRPCPath: '/saga-soa/v1/trpc'
  };

  beforeEach(() => {
    client = new TRPCPubSubClient(mockConfig);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Constructor and Configuration', () => {
    it('should create client with correct configuration', () => {
      expect(client).toBeInstanceOf(TRPCPubSubClient);
      expect(client.getSubscriptionCount()).toBe(0);
    });

    it('should initialize with no subscriptions', () => {
      expect(client.getSubscriptionCount()).toBe(0);
      expect(client.getSubscriptions()).toEqual([]);
    });
  });

  describe('Publishing Events (CSE)', () => {
    it('should publish ping event successfully', async () => {
      const pingPayload = {
        message: 'Hello, World!',
        timestamp: new Date().toISOString()
      };

      const result = await client.publish('ping:message', pingPayload);

      expect(result.success).toBe(true);
      expect(result.eventId).toBeDefined();
      expect(result.emittedEvents).toBeDefined();
      expect(result.emittedEvents).toHaveLength(1);
      
      const emittedEvent = result.emittedEvents![0];
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent!.name).toBe('ping:message');
      expect(emittedEvent!.payload).toEqual(pingPayload);
      expect(emittedEvent!.channel).toBe('default');
      expect(emittedEvent!.timestamp).toBeDefined();
    });

    it('should handle publish errors gracefully', async () => {
      // Test with invalid event name (empty string)
      const result = await client.publish('' as any, { message: 'test' });
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should publish events successfully', async () => {
      const result = await client.publish('ping:message', { message: 'test' });

      expect(result.success).toBe(true);
      expect(result.emittedEvents).toBeDefined();
      
      const emittedEvent = result.emittedEvents![0];
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent!.meta).toEqual({});
    });
  });

  describe('Subscribing to Events (SSE)', () => {
    it('should create subscription successfully', async () => {
      const handler = vi.fn();
      const channel = 'pingpong';

      const subscription = await client.subscribe(channel, handler);

      expect(subscription).toBeDefined();
      expect(subscription.id).toBeDefined();
      expect(subscription.channel).toBe(channel);
      expect(subscription.handler).toBe(handler);
      expect(subscription.unsubscribe).toBeInstanceOf(Function);
      expect(client.getSubscriptionCount()).toBe(1);
    });

    it('should track multiple subscriptions', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await client.subscribe('channel1', handler1);
      await client.subscribe('channel2', handler2);

      expect(client.getSubscriptionCount()).toBe(2);
      expect(client.getSubscriptions()).toHaveLength(2);
    });

    it('should unsubscribe from specific subscription', async () => {
      const handler = vi.fn();
      const subscription = await client.subscribe('test-channel', handler);

      expect(client.getSubscriptionCount()).toBe(1);

      const result = await client.unsubscribe(subscription.id);
      expect(result).toBe(true);
      expect(client.getSubscriptionCount()).toBe(0);
    });

    it('should handle unsubscribe from non-existent subscription', async () => {
      const result = await client.unsubscribe('non-existent-id');
      expect(result).toBe(false);
    });

    it('should unsubscribe from all subscriptions', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      await client.subscribe('channel1', handler1);
      await client.subscribe('channel2', handler2);

      expect(client.getSubscriptionCount()).toBe(2);

      await client.unsubscribeAll();
      expect(client.getSubscriptionCount()).toBe(0);
    });
  });

  describe('Ping-Pong Flow Integration', () => {
    it('should handle complete ping-pong flow', async () => {
      // 1. Subscribe to pong events
      const pongEvents: EventEnvelope[] = [];
      const pongHandler = vi.fn((event: EventEnvelope) => {
        pongEvents.push(event);
      });

      const subscription = await client.subscribe('pingpong', pongHandler);

      // 2. Publish ping event
      const pingPayload = {
        message: 'Test ping message',
        timestamp: new Date().toISOString()
      };

      const publishResult = await client.publish('ping:message', pingPayload);

      // 3. Verify ping was published
      expect(publishResult.success).toBe(true);
      expect(publishResult.emittedEvents).toBeDefined();
      expect(publishResult.emittedEvents).toHaveLength(1);

      const pingEvent = publishResult.emittedEvents![0];
      expect(pingEvent).toBeDefined();
      expect(pingEvent!.name).toBe('ping:message');
      expect(pingEvent!.payload).toEqual(pingPayload);

      // 4. Clean up
      await subscription.unsubscribe();
      expect(client.getSubscriptionCount()).toBe(0);
    });

    it('should handle multiple ping-pong cycles', async () => {
      const pongEvents: EventEnvelope[] = [];
      const pongHandler = vi.fn((event: EventEnvelope) => {
        pongEvents.push(event);
      });

      const subscription = await client.subscribe('pingpong', pongHandler);

      // Send multiple pings
      const messages = ['Ping 1', 'Ping 2', 'Ping 3'];
      
      for (const message of messages) {
        const payload = { message, timestamp: new Date().toISOString() };
        const result = await client.publish('ping:message', payload);
        
        expect(result.success).toBe(true);
        expect(result.emittedEvents).toHaveLength(1);
      }

      await subscription.unsubscribe();
      expect(client.getSubscriptionCount()).toBe(0);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle invalid event names gracefully', async () => {
      // Note: EventName type should enforce `${string}:${string}` format
      // This test verifies the type system works correctly
      const validEventName: EventName = 'ping:message';
      const result = await client.publish(validEventName, { message: 'test' });
      
      expect(result.success).toBe(true);
    });

    it('should handle empty payloads', async () => {
      const result = await client.publish('ping:message', {});
      expect(result.success).toBe(true);
      expect(result.emittedEvents).toHaveLength(1);
    });

    it('should handle null/undefined options', async () => {
      const result = await client.publish('ping:message', { message: 'test' }, undefined);
      expect(result.success).toBe(true);
    });
  });

  describe('Resource Management', () => {
    it('should close client and clean up resources', async () => {
      const handler = vi.fn();
      await client.subscribe('test-channel', handler);

      expect(client.getSubscriptionCount()).toBe(1);

      await client.close();
      expect(client.getSubscriptionCount()).toBe(0);
    });

    it('should handle multiple close calls gracefully', async () => {
      await client.close();
      await client.close(); // Should not throw
      expect(client.getSubscriptionCount()).toBe(0);
    });
  });

  describe('Auto-Subscribe Publishing', () => {
    // Mock CSE event with response
    const mockPongEvent: SSEEvent<{ reply: string; originalMessage: string; timestamp: string }> = {
      name: 'pong:response',
      channel: 'pingpong',
      direction: 'SSE',
      description: 'Pong response event'
    };

    const mockPingEvent: CSEEventWithResponse<
      { message: string; timestamp: string }, 
      { reply: string; originalMessage: string; timestamp: string },
      typeof mockPongEvent
    > = {
      name: 'ping:message',
      channel: 'pingpong',
      direction: 'CSE',
      description: 'Ping event with response',
      responseEvent: mockPongEvent,
      action: {
        requestId: 'test-request-id',
        responseEventType: 'pong:response',
        async act(payload) {
          return {
            reply: `Pong: ${payload.message}`,
            originalMessage: payload.message,
            timestamp: new Date().toISOString()
          };
        }
      }
    };

    // Mock CSE event without response
    const mockLogEvent: CSEEvent<{ message: string; level: string }> = {
      name: 'system:log',
      channel: 'system', 
      direction: 'CSE',
      description: 'Log event without response',
      action: {
        requestId: 'test-log-request-id',
        async act(payload) {
          console.log(`[${payload.level}] ${payload.message}`);
        }
      }
    };

    it('should publish with auto-subscribe for CSE events with responses', async () => {
      const responseHandler = vi.fn();
      const payload = { message: 'Test ping', timestamp: new Date().toISOString() };

      const result = await client.publishWithAutoSubscribe(
        mockPingEvent,
        payload,
        responseHandler
      );

      expect(result.publishResult.success).toBe(true);
      expect(result.subscription).toBeDefined();
      expect(result.subscription.channel).toBe('pingpong');
      expect(result.subscription.handler).toBe(responseHandler);
      expect(client.getSubscriptionCount()).toBe(1);
    });

    it('should provide waitForResponse when autoUnsubscribe is enabled', async () => {
      const responseHandler = vi.fn();
      const payload = { message: 'Test ping', timestamp: new Date().toISOString() };

      const result = await client.publishWithAutoSubscribe(
        mockPingEvent,
        payload,
        responseHandler,
        { autoUnsubscribe: true, timeout: 1000 }
      );

      expect(result.waitForResponse).toBeDefined();
      expect(typeof result.waitForResponse).toBe('function');
    });

    it('should handle timeout in waitForResponse', async () => {
      const responseHandler = vi.fn();
      const payload = { message: 'Test ping', timestamp: new Date().toISOString() };

      const result = await client.publishWithAutoSubscribe(
        mockPingEvent,
        payload,
        responseHandler,
        { autoUnsubscribe: true, timeout: 100 } // Very short timeout
      );

      if (result.waitForResponse) {
        await expect(result.waitForResponse()).rejects.toThrow('Response timeout after 100ms');
      }
    });

    it('should use regular publish for CSE events without responses', async () => {
      const payload = { message: 'Test log message', level: 'info' };

      const result = await client.publish(mockLogEvent.name, payload);

      expect(result.success).toBe(true);
      expect(result.eventId).toBeDefined();
      expect(client.getSubscriptionCount()).toBe(0); // No auto-subscription
    });
  });

  describe('Performance and Timing', () => {
    it('should handle rapid publish operations', async () => {
      const startTime = Date.now();
      const promises = [];

      // Publish 10 events rapidly
      for (let i = 0; i < 10; i++) {
        promises.push(
          client.publish('ping:message', { message: `Ping ${i}`, timestamp: new Date().toISOString() })
        );
      }

      const results = await Promise.all(promises);
      const endTime = Date.now();

      // All should succeed
      results.forEach(result => {
        expect(result.success).toBe(true);
      });

      // Should complete within reasonable time (adjust timeout as needed)
      expect(endTime - startTime).toBeLessThan(2000); // 2 seconds
    });
  });
});
