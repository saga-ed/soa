import { describe, it, expect } from 'vitest';
import type { EventEnvelope, EventName } from '../../types/event.js';

describe('EventEnvelope', () => {
  it('should create valid event envelope', () => {
    const event: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString()
    };

    expect(event.name).toBe('orders:created');
    expect(event.channel).toBe('orders');
    expect(event.payload).toEqual({ orderId: '123', total: 100 });
  });

  it('should support optional metadata', () => {
    const event: EventEnvelope<'orders:created'> = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'orders:created',
      channel: 'orders',
      payload: { orderId: '123', total: 100 },
      timestamp: new Date().toISOString(),
      meta: {
        source: 'api',
        version: 1,
        userId: 'user123'
      }
    };

    expect(event.meta?.source).toBe('api');
    expect(event.meta?.version).toBe(1);
  });
});

describe('EventName', () => {
  it('should enforce correct event name format', () => {
    // These should be valid
    const validNames: EventName[] = [
      'orders:created',
      'users:updated',
      'payments:processed'
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^[^:]+:[^:]+$/);
    });
  });
}); 