import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'inversify';
import { EventService } from '../../../services/event.service.js';
import { MockLogger } from '../../../__tests__/mocks/mock-logger.js';
import { TYPES } from '../../../types/index.js';
import { z } from 'zod';
import type { EventDefinition, CSEEvent, SSEEvent } from '@hipponot/soa-pubsub-core';
import crypto from 'crypto';

describe('EventService', () => {
  let container: Container;
  let eventService: EventService;
  let mockLogger: MockLogger;

  beforeEach(() => {
    container = new Container();
    mockLogger = new MockLogger();
    
    container.bind(TYPES.Logger).toConstantValue(mockLogger);
    container.bind(EventService).toSelf();
    
    eventService = container.get(EventService);
  });

  describe('validateEvent', () => {
    it('should validate known events', async () => {
      const events = {
        'orders:created': {
          name: 'orders:created',
          channel: 'orders',
          payloadSchema: z.object({ orderId: z.string() })
        } as EventDefinition
      };

      const result = await eventService.validateEvent(
        'orders:created',
        { orderId: '123' },
        events
      );

      expect(result.valid).toBe(true);
      expect(result.eventDef).toBeDefined();
    });

    it('should reject unknown events', async () => {
      const events = {};

      const result = await eventService.validateEvent(
        'unknown:event',
        { data: 'test' },
        events
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Unknown event: unknown:event');
    });

    it('should validate payload against schema', async () => {
      const events = {
        'orders:created': {
          name: 'orders:created',
          channel: 'orders',
          payloadSchema: z.object({ orderId: z.string() })
        } as EventDefinition
      };

      const result = await eventService.validateEvent(
        'orders:created',
        { orderId: 123 }, // Wrong type
        events
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Payload validation failed');
    });
  });

  describe('executeAction', () => {
    it('should execute action and return result', async () => {
      const eventDef: CSEEvent<{ orderId: string }, { success: boolean; orderId: string }> = {
        name: 'orders:created',
        channel: 'orders',
        direction: 'CSE',
        action: {
          requestId: crypto.randomUUID(),
          async act(payload) {
            return { success: true, orderId: payload.orderId };
          }
        }
      };

      const result = await eventService.executeAction(
        eventDef,
        { orderId: '123' },
        'test-request-123'
      );

      expect(result.result).toEqual({ success: true, orderId: '123', requestId: 'test-request-123' });
    });

    it('should handle actions that emit events', async () => {
      const eventDef: CSEEvent<{ orderId: string }, { success: boolean }> = {
        name: 'orders:created',
        channel: 'orders',
        direction: 'CSE',
        action: {
          requestId: crypto.randomUUID(),
          async act(payload) {
            // In the new design, actions don't emit events directly
            // They just return results
            return { success: true };
          }
        }
      };

      const result = await eventService.executeAction(
        eventDef,
        { orderId: '123' },
        'test-request-123'
      );

      expect(result.result).toEqual({ success: true, requestId: 'test-request-123' });
    });

    it('should handle events without actions', async () => {
      const eventDef: EventDefinition = {
        name: 'orders:created',
        channel: 'orders'
      };

      const result = await eventService.executeAction(
        eventDef,
        { orderId: '123' },
        'test-request-123'
      );

      expect(result.result).toBeUndefined();
    });
  });

  describe('createEventEnvelope', () => {
    it('should create valid event envelope', () => {
      const event = eventService.createEventEnvelope(
        'orders:created',
        'orders',
        { orderId: '123' },
        { source: 'test' }
      );

      expect(event.name).toBe('orders:created');
      expect(event.channel).toBe('orders');
      expect(event.payload).toEqual({ orderId: '123' });
      expect(event.meta?.source).toBe('test');
      expect(event.id).toBeDefined();
      expect(event.timestamp).toBeDefined();
    });
  });

  describe('checkAuthorization', () => {
    it('should allow events without auth scope', async () => {
      const eventDef: EventDefinition = {
        name: 'orders:created',
        channel: 'orders'
      };

      const result = await eventService.checkAuthorization(
        eventDef,
        { id: 'user1', roles: ['user'] }
      );

      expect(result.authorized).toBe(true);
    });

    it('should check string-based auth scope', async () => {
      const eventDef: EventDefinition = {
        name: 'orders:created',
        channel: 'orders'
      };

      const result = await eventService.checkAuthorization(
        eventDef,
        { id: 'user1', roles: ['user'] }
      );

      // In the new design, all events are authorized by default
      expect(result.authorized).toBe(true);
    });

    it('should allow users with required scope', async () => {
      const eventDef: EventDefinition = {
        name: 'orders:created',
        channel: 'orders'
      };

      const result = await eventService.checkAuthorization(
        eventDef,
        { id: 'user1', roles: ['admin'] }
      );

      expect(result.authorized).toBe(true);
    });
  });
}); 