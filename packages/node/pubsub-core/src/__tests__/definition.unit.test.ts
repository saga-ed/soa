import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { EventDefinition, AbsAction } from '../../types/index.js';

describe('EventDefinition', () => {
  it('should support basic event definition', () => {
    const definition: EventDefinition<{ orderId: string }, { success: boolean }> = {
      name: 'orders:created',
      channel: 'orders',
      description: 'Order created event',
      version: 1
    };

    expect(definition.name).toBe('orders:created');
    expect(definition.channel).toBe('orders');
    expect(definition.description).toBe('Order created event');
    expect(definition.version).toBe(1);
  });

  it('should support payload schema validation', () => {
    const orderSchema = z.object({
      orderId: z.string(),
      total: z.number()
    });

    const definition: EventDefinition<z.infer<typeof orderSchema>> = {
      name: 'orders:created',
      channel: 'orders',
      payloadSchema: orderSchema
    };

    expect(definition.payloadSchema).toBeDefined();
  });

  it('should support action functions', () => {
    const definition: EventDefinition<{ orderId: string }, { success: boolean }> = {
      name: 'orders:created',
      channel: 'orders',
      direction: 'CSE',
      action: {
        requestId: crypto.randomUUID(),
        async act(payload) {
          return { success: true };
        }
      }
    };

    expect(definition.action).toBeDefined();
  });

  it('should support direction specification', () => {
    const sseDefinition: EventDefinition = {
      name: 'orders:created',
      channel: 'orders',
      direction: 'SSE'
    };

    const cseDefinition: EventDefinition = {
      name: 'orders:create',
      channel: 'orders',
      direction: 'CSE'
    };

    const bothDefinition: EventDefinition = {
      name: 'orders:updated',
      channel: 'orders',
      direction: 'BOTH'
    };

    expect(sseDefinition.direction).toBe('SSE');
    expect(cseDefinition.direction).toBe('CSE');
    expect(bothDefinition.direction).toBe('BOTH');
  });
});

describe('ChannelConfig', () => {
  it('should support channel configuration', () => {
    const config = {
      name: 'orders',
      family: 'commerce',
      ordered: true,
      maxSubscribers: 1000,
      maxEventSize: 1024 * 1024 // 1MB
    };

    expect(config.name).toBe('orders');
    expect(config.ordered).toBe(true);
    expect(config.maxSubscribers).toBe(1000);
  });
}); 