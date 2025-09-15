import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryAdapter } from '../../../adapters/in-memory-adapter.js';
import type { EventEnvelope } from '@hipponot/soa-pubsub-core';

describe('InMemoryAdapter', () => {
  let adapter: InMemoryAdapter;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
  });

  describe('Constructor and Configuration', () => {
    it('should create adapter with default options', () => {
      const defaultAdapter = new InMemoryAdapter();
      expect(defaultAdapter.getEventCount()).toBe(0);
      expect(defaultAdapter.getSubscriberCount()).toBe(0);
    });

    it('should create adapter with custom options', () => {
      const customAdapter = new InMemoryAdapter({
        maxHistoryPerChannel: 50,
        enablePersistence: false
      });
      
      expect(customAdapter).toBeDefined();
    });
  });

  describe('Publish and Subscribe', () => {
    it('should publish and receive events', async () => {
      const receivedEvents: EventEnvelope[] = [];
      
      // Subscribe to channel
      const { unsubscribe } = await adapter.subscribe('test-channel', async (event) => {
        receivedEvents.push(event);
      });

      // Publish event
      const testEvent: EventEnvelope = {
        id: '123',
        name: 'test:event',
        channel: 'test-channel',
        payload: { message: 'Hello World' },
        timestamp: new Date().toISOString()
      };

      await adapter.publish(testEvent);

      // Verify event was received
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]).toEqual(testEvent);
      expect(adapter.getEventCount('test-channel')).toBe(1);

      await unsubscribe();
    });

    it('should support multiple subscribers on same channel', async () => {
      const subscriber1Events: EventEnvelope[] = [];
      const subscriber2Events: EventEnvelope[] = [];

      // Subscribe two handlers
      const { unsubscribe: unsub1 } = await adapter.subscribe('test-channel', async (event) => {
        subscriber1Events.push(event);
      });

      const { unsubscribe: unsub2 } = await adapter.subscribe('test-channel', async (event) => {
        subscriber2Events.push(event);
      });

      const testEvent: EventEnvelope = {
        id: '123',
        name: 'test:event',
        channel: 'test-channel',
        payload: { message: 'Hello World' },
        timestamp: new Date().toISOString()
      };

      await adapter.publish(testEvent);

      // Both subscribers should receive the event
      expect(subscriber1Events).toHaveLength(1);
      expect(subscriber2Events).toHaveLength(1);
      expect(subscriber1Events[0]).toEqual(testEvent);
      expect(subscriber2Events[0]).toEqual(testEvent);
      expect(adapter.getSubscriberCount('test-channel')).toBe(2);

      await unsub1();
      await unsub2();
    });

    it('should handle subscriber errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Subscribe handler that throws error
      const { unsubscribe } = await adapter.subscribe('test-channel', async () => {
        throw new Error('Subscriber error');
      });

      const testEvent: EventEnvelope = {
        id: '123',
        name: 'test:event',
        channel: 'test-channel',
        payload: { message: 'Hello World' },
        timestamp: new Date().toISOString()
      };

      // Should not throw error
      await expect(adapter.publish(testEvent)).resolves.not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error in subscriber for channel test-channel:'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
      await unsubscribe();
    });

    it('should only notify subscribers of the correct channel', async () => {
      const channel1Events: EventEnvelope[] = [];
      const channel2Events: EventEnvelope[] = [];

      // Subscribe to different channels
      const { unsubscribe: unsub1 } = await adapter.subscribe('channel1', async (event) => {
        channel1Events.push(event);
      });

      const { unsubscribe: unsub2 } = await adapter.subscribe('channel2', async (event) => {
        channel2Events.push(event);
      });

      // Publish to channel1 only
      const testEvent: EventEnvelope = {
        id: '123',
        name: 'test:event',
        channel: 'channel1',
        payload: { message: 'Hello World' },
        timestamp: new Date().toISOString()
      };

      await adapter.publish(testEvent);

      // Only channel1 subscriber should receive the event
      expect(channel1Events).toHaveLength(1);
      expect(channel2Events).toHaveLength(0);

      await unsub1();
      await unsub2();
    });
  });

  describe('Event History and Persistence', () => {
    it('should store events in history', async () => {
      const events: EventEnvelope[] = [
        {
          id: '1',
          name: 'test:event1',
          channel: 'test-channel',
          payload: { message: 'Event 1' },
          timestamp: new Date('2024-01-01T10:00:00Z').toISOString()
        },
        {
          id: '2',
          name: 'test:event2',
          channel: 'test-channel',
          payload: { message: 'Event 2' },
          timestamp: new Date('2024-01-01T11:00:00Z').toISOString()
        }
      ];

      for (const event of events) {
        await adapter.publish(event);
      }

      const history = await adapter.fetchHistory('test-channel');
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(events[0]);
      expect(history[1]).toEqual(events[1]);
    });

    it('should maintain max history limit', async () => {
      const smallAdapter = new InMemoryAdapter({ maxHistoryPerChannel: 2 });

      // Publish 3 events
      for (let i = 1; i <= 3; i++) {
        await smallAdapter.publish({
          id: i.toString(),
          name: `test:event${i}`,
          channel: 'test-channel',
          payload: { message: `Event ${i}` },
          timestamp: new Date().toISOString()
        });
      }

      const history = await smallAdapter.fetchHistory('test-channel');
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('2'); // First event should be removed
      expect(history[1].id).toBe('3');
    });

    it('should filter history by timestamp', async () => {
      const baseTime = new Date('2024-01-01T10:00:00Z');
      
      const events: EventEnvelope[] = [
        {
          id: '1',
          name: 'test:event1',
          channel: 'test-channel',
          payload: { message: 'Event 1' },
          timestamp: new Date(baseTime.getTime()).toISOString()
        },
        {
          id: '2',
          name: 'test:event2',
          channel: 'test-channel',
          payload: { message: 'Event 2' },
          timestamp: new Date(baseTime.getTime() + 60000).toISOString() // +1 minute
        },
        {
          id: '3',
          name: 'test:event3',
          channel: 'test-channel',
          payload: { message: 'Event 3' },
          timestamp: new Date(baseTime.getTime() + 120000).toISOString() // +2 minutes
        }
      ];

      for (const event of events) {
        await adapter.publish(event);
      }

      // Get events after the first event
      const since = new Date(baseTime.getTime() + 30000).toISOString(); // +30 seconds
      const filteredHistory = await adapter.fetchHistory('test-channel', { since });
      
      expect(filteredHistory).toHaveLength(2);
      expect(filteredHistory[0].id).toBe('2');
      expect(filteredHistory[1].id).toBe('3');
    });

    it('should limit history results', async () => {
      // Publish 5 events
      for (let i = 1; i <= 5; i++) {
        await adapter.publish({
          id: i.toString(),
          name: `test:event${i}`,
          channel: 'test-channel',
          payload: { message: `Event ${i}` },
          timestamp: new Date().toISOString()
        });
      }

      const limitedHistory = await adapter.fetchHistory('test-channel', { limit: 3 });
      expect(limitedHistory).toHaveLength(3);
      expect(limitedHistory[0].id).toBe('3'); // Most recent 3 events
      expect(limitedHistory[1].id).toBe('4');
      expect(limitedHistory[2].id).toBe('5');
    });

    it('should return empty array for non-existent channel', async () => {
      const history = await adapter.fetchHistory('non-existent-channel');
      expect(history).toEqual([]);
    });
  });

  describe('Subscription Management', () => {
    it('should unsubscribe correctly', async () => {
      const receivedEvents: EventEnvelope[] = [];
      
      const { unsubscribe } = await adapter.subscribe('test-channel', async (event) => {
        receivedEvents.push(event);
      });

      expect(adapter.getSubscriberCount('test-channel')).toBe(1);

      await unsubscribe();
      expect(adapter.getSubscriberCount('test-channel')).toBe(0);

      // Publish event after unsubscribe
      await adapter.publish({
        id: '123',
        name: 'test:event',
        channel: 'test-channel',
        payload: { message: 'Should not be received' },
        timestamp: new Date().toISOString()
      });

      expect(receivedEvents).toHaveLength(0);
    });

    it('should clean up empty subscriber sets', async () => {
      const { unsubscribe } = await adapter.subscribe('test-channel', async () => {});
      
      expect(adapter.getChannels()).toContain('test-channel');
      
      await unsubscribe();
      
      // Channel should be removed from subscriber tracking when no subscribers remain
      expect(adapter.getSubscriberCount('test-channel')).toBe(0);
    });
  });

  describe('Health Check', () => {
    it('should return healthy status with details', async () => {
      // Add some data
      await adapter.publish({
        id: '1',
        name: 'test:event',
        channel: 'channel1',
        payload: { message: 'Event 1' },
        timestamp: new Date().toISOString()
      });

      const { unsubscribe } = await adapter.subscribe('channel1', async () => {});

      const health = await adapter.health();
      
      expect(health.healthy).toBe(true);
      expect(health.details).toBeDefined();
      expect(health.details.channels).toContain('channel1');
      expect(health.details.totalEvents).toBe(1);
      expect(health.details.totalSubscribers).toBe(1);
      expect(health.details.maxHistoryPerChannel).toBe(100);
      expect(health.details.persistenceEnabled).toBe(true);

      await unsubscribe();
    });
  });

  describe('Utility Methods', () => {
    it('should track event counts correctly', async () => {
      expect(adapter.getEventCount()).toBe(0);
      expect(adapter.getEventCount('channel1')).toBe(0);

      await adapter.publish({
        id: '1',
        name: 'test:event',
        channel: 'channel1',
        payload: {},
        timestamp: new Date().toISOString()
      });

      await adapter.publish({
        id: '2',
        name: 'test:event',
        channel: 'channel2',
        payload: {},
        timestamp: new Date().toISOString()
      });

      expect(adapter.getEventCount()).toBe(2);
      expect(adapter.getEventCount('channel1')).toBe(1);
      expect(adapter.getEventCount('channel2')).toBe(1);
    });

    it('should track subscriber counts correctly', async () => {
      expect(adapter.getSubscriberCount()).toBe(0);

      const { unsubscribe: unsub1 } = await adapter.subscribe('channel1', async () => {});
      const { unsubscribe: unsub2 } = await adapter.subscribe('channel1', async () => {});
      const { unsubscribe: unsub3 } = await adapter.subscribe('channel2', async () => {});

      expect(adapter.getSubscriberCount()).toBe(3);
      expect(adapter.getSubscriberCount('channel1')).toBe(2);
      expect(adapter.getSubscriberCount('channel2')).toBe(1);

      await unsub1();
      await unsub2();
      await unsub3();
    });

    it('should list all channels', async () => {
      expect(adapter.getChannels()).toEqual([]);

      await adapter.publish({
        id: '1',
        name: 'test:event',
        channel: 'channel1',
        payload: {},
        timestamp: new Date().toISOString()
      });

      const { unsubscribe } = await adapter.subscribe('channel2', async () => {});

      const channels = adapter.getChannels();
      expect(channels).toContain('channel1');
      expect(channels).toContain('channel2');

      await unsubscribe();
    });

    it('should clear data correctly', async () => {
      // Add data
      await adapter.publish({
        id: '1',
        name: 'test:event',
        channel: 'channel1',
        payload: {},
        timestamp: new Date().toISOString()
      });

      const { unsubscribe } = await adapter.subscribe('channel1', async () => {});

      expect(adapter.getEventCount()).toBe(1);
      expect(adapter.getSubscriberCount()).toBe(1);

      // Clear specific channel
      adapter.clear('channel1');
      expect(adapter.getEventCount('channel1')).toBe(0);
      expect(adapter.getSubscriberCount('channel1')).toBe(0);

      // Add data again
      await adapter.publish({
        id: '2',
        name: 'test:event',
        channel: 'channel2',
        payload: {},
        timestamp: new Date().toISOString()
      });

      // Clear all
      adapter.clear();
      expect(adapter.getEventCount()).toBe(0);
      expect(adapter.getSubscriberCount()).toBe(0);

      await unsubscribe();
    });
  });

  describe('Shutdown', () => {
    it('should clear all data on shutdown', async () => {
      // Add some data
      await adapter.publish({
        id: '1',
        name: 'test:event',
        channel: 'channel1',
        payload: {},
        timestamp: new Date().toISOString()
      });

      const { unsubscribe } = await adapter.subscribe('channel1', async () => {});

      expect(adapter.getEventCount()).toBe(1);
      expect(adapter.getSubscriberCount()).toBe(1);

      await adapter.shutdown();

      expect(adapter.getEventCount()).toBe(0);
      expect(adapter.getSubscriberCount()).toBe(0);
      expect(adapter.getChannels()).toEqual([]);

      await unsubscribe();
    });
  });
});
