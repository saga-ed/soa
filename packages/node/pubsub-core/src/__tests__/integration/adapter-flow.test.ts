import { describe, it, expect, beforeEach } from 'vitest';
import { MockAdapter } from '../mocks/mock-adapter.js';
import type { EventEnvelope } from '../../types/event.js';

describe('Adapter Flow Integration', () => {
  let adapter: MockAdapter;

  beforeEach(() => {
    adapter = new MockAdapter();
  });

  it('should handle complete publish-subscribe flow', async () => {
    const receivedEvents: EventEnvelope[] = [];
    
    // Subscribe to orders channel
    const { unsubscribe } = await adapter.subscribe('orders', async (event) => {
      receivedEvents.push(event);
    });

    // Publish an event
    const testEvent: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString()
    };

    await adapter.publish(testEvent);

    // Verify event was received
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual(testEvent);
    expect(adapter.getEventCount()).toBe(1);

    // Cleanup
    await unsubscribe();
  });

  it('should support multiple subscribers on same channel', async () => {
    const subscriber1Events: EventEnvelope[] = [];
    const subscriber2Events: EventEnvelope[] = [];

    // Subscribe two handlers to the same channel
    const { unsubscribe: unsub1 } = await adapter.subscribe('orders', async (event) => {
      subscriber1Events.push(event);
    });

    const { unsubscribe: unsub2 } = await adapter.subscribe('orders', async (event) => {
      subscriber2Events.push(event);
    });

    // Publish an event
    const testEvent: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString()
    };

    await adapter.publish(testEvent);

    // Verify both subscribers received the event
    expect(subscriber1Events).toHaveLength(1);
    expect(subscriber2Events).toHaveLength(1);
    expect(subscriber1Events[0]).toEqual(testEvent);
    expect(subscriber2Events[0]).toEqual(testEvent);
    expect(adapter.getSubscriberCount('orders')).toBe(2);

    // Cleanup
    await unsub1();
    await unsub2();
  });

  it('should handle event history and persistence', async () => {
    // Publish some events
    const events: EventEnvelope[] = [
      {
        id: '1',
        name: 'orders:created',
        channel: 'orders',
        payload: { orderId: '1', total: 100 },
        timestamp: new Date('2024-01-01T00:00:00Z').toISOString()
      },
      {
        id: '2',
        name: 'orders:created',
        channel: 'orders',
        payload: { orderId: '2', total: 200 },
        timestamp: new Date('2024-01-02T00:00:00Z').toISOString()
      }
    ];

    for (const event of events) {
      await adapter.publish(event);
    }

    // Test history retrieval
    const history = await adapter.fetchHistory('orders');
    expect(history).toHaveLength(2);

    // Test history with since filter
    const recentHistory = await adapter.fetchHistory('orders', { 
      since: '2024-01-01T12:00:00Z' 
    });
    expect(recentHistory).toHaveLength(1);
    expect(recentHistory[0].id).toBe('2');

    // Test history with limit
    const limitedHistory = await adapter.fetchHistory('orders', { limit: 1 });
    expect(limitedHistory).toHaveLength(1);
    expect(limitedHistory[0].id).toBe('2'); // Most recent
  });

  it('should handle health checks and shutdown', async () => {
    // Subscribe to a channel
    const { unsubscribe } = await adapter.subscribe('orders', async () => {});
    
    // Publish an event
    const testEvent: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString()
    };

    await adapter.publish(testEvent);

    // Check health
    const health = await adapter.health();
    expect(health.healthy).toBe(true);
    expect(health.details?.eventCount).toBe(1);
    expect(health.details?.subscriberCount).toBe(1);

    // Cleanup
    await unsubscribe();
    await adapter.shutdown();

    // Verify shutdown cleared everything
    expect(adapter.getEventCount()).toBe(0);
    expect(adapter.getSubscriberCount()).toBe(0);
  });
}); 