import { describe, it, expect, beforeEach } from 'vitest';
import { 
  testPingEvent, 
  testPongEvent, 
  createTestPingEnvelope, 
  createTestPingEnvelope, 
  createTestPongEnvelope,
  createMockAbsAction,
  validatePingPayload,
  validatePongPayload,
  isValidEventEnvelope,
  pingPayloadSchema,
  pongPayloadSchema,
  type PingPayload,
  type PongPayload
} from './fixtures/test-events.js';
import type { EventEnvelope, AbsAction } from '../../types/index.js';

describe('Event Construction Tests', () => {
  describe('Ping Event (CSE)', () => {
    it('should create valid ping event definition', () => {
      expect(testPingEvent.name).toBe('ping');
      expect(testPingEvent.channel).toBe('pingpong');
      expect(testPingEvent.direction).toBe('CSE');
      expect(testPingEvent.payloadSchema).toBeDefined();
      expect(testPingEvent.action).toBeDefined();
    });

    it('should validate ping payload schema', () => {
      const validPayload: PingPayload = {
        message: 'Hello World',
        timestamp: new Date().toISOString()
      };

      const result = pingPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      expect(validatePingPayload(validPayload)).toBe(true);
    });

    it('should reject invalid ping payload', () => {
      const invalidPayload = {
        message: 123, // should be string
        timestamp: 'invalid-date'
      };

      const result = pingPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
      expect(validatePingPayload(invalidPayload)).toBe(false);
    });

    it('should create valid ping event envelope', () => {
      const envelope = createTestPingEnvelope('Test message');
      
      expect(envelope.name).toBe('ping');
      expect(envelope.channel).toBe('pingpong');
      expect(envelope.payload.message).toBe('Test message');
      expect(envelope.payload.timestamp).toBeDefined();
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.id).toBeDefined();
      expect(isValidEventEnvelope(envelope)).toBe(true);
    });

    it('should execute ping event action successfully', async () => {
      const mockAction = createMockAbsAction();
      const payload: PingPayload = {
        message: 'Test ping',
        timestamp: new Date().toISOString()
      };

              const result = await testPingEvent.action!.act(payload);
      
      expect(result).toEqual({ success: true });
    });
  });

  describe('Pong Event (SSE)', () => {
    it('should create valid pong event definition', () => {
      expect(testPongEvent.name).toBe('pong');
      expect(testPongEvent.channel).toBe('pingpong');
      expect(testPongEvent.direction).toBe('SSE');
      expect(testPongEvent.payloadSchema).toBeDefined();
      expect(testPongEvent.action).toBeUndefined(); // SSE events don't have actions
    });

    it('should validate pong payload schema', () => {
      const validPayload: PongPayload = {
        reply: 'Pong! Received: Hello',
        originalMessage: 'Hello',
        timestamp: new Date().toISOString()
      };

      const result = pongPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
      expect(validatePongPayload(validPayload)).toBe(true);
    });

    it('should reject invalid pong payload', () => {
      const invalidPayload = {
        reply: 123, // should be string
        originalMessage: null, // should be string
        timestamp: 'invalid'
      };

      const result = pongPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
      expect(validatePongPayload(invalidPayload)).toBe(false);
    });

    it('should create valid pong event envelope', () => {
      const envelope = createTestPongEnvelope('Pong response', 'Original message');
      
      expect(envelope.name).toBe('pong');
      expect(envelope.channel).toBe('pingpong');
      expect(envelope.payload.reply).toBe('Pong response');
      expect(envelope.payload.originalMessage).toBe('Original message');
      expect(envelope.payload.timestamp).toBeDefined();
      expect(envelope.timestamp).toBeDefined();
      expect(envelope.id).toBeDefined();
      expect(isValidEventEnvelope(envelope)).toBe(true);
    });
  });

  describe('Event Envelope Structure', () => {
    it('should create event envelopes with required fields', () => {
      const pingEnvelope = createTestPingEnvelope('test');
      const pongEnvelope = createTestPongEnvelope('reply', 'original');

      // Test ping envelope structure
      expect(pingEnvelope).toHaveProperty('id');
      expect(pingEnvelope).toHaveProperty('name', 'ping');
      expect(pingEnvelope).toHaveProperty('channel', 'pingpong');
      expect(pingEnvelope).toHaveProperty('payload');
      expect(pingEnvelope).toHaveProperty('timestamp');
      expect(pingEnvelope).toHaveProperty('meta');

      // Test pong envelope structure
      expect(pongEnvelope).toHaveProperty('id');
      expect(pongEnvelope).toHaveProperty('name', 'pong');
      expect(pongEnvelope).toHaveProperty('channel', 'pingpong');
      expect(pongEnvelope).toHaveProperty('payload');
      expect(pongEnvelope).toHaveProperty('timestamp');
      expect(pongEnvelope).toHaveProperty('meta');
    });

    it('should support custom overrides in event envelopes', () => {
      const customId = 'custom-test-id';
      const customMeta = { source: 'custom', version: 2 };
      
      const envelope = createTestPingEnvelope('test', {
        id: customId,
        meta: customMeta
      });

      expect(envelope.id).toBe(customId);
      expect(envelope.meta).toEqual(customMeta);
    });

    it('should generate unique IDs for each envelope', () => {
      const envelope1 = createTestPingEnvelope('test1');
      const envelope2 = createTestPingEnvelope('test2');
      
      expect(envelope1.id).not.toBe(envelope2.id);
      expect(envelope1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(envelope2.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should have valid timestamps', () => {
      const envelope = createTestPingEnvelope('test');
      
      expect(() => new Date(envelope.timestamp)).not.toThrow();
      expect(() => new Date(envelope.payload.timestamp)).not.toThrow();
      
      const envelopeDate = new Date(envelope.timestamp);
      const payloadDate = new Date(envelope.payload.timestamp);
      
      expect(envelopeDate.getTime()).toBeGreaterThan(0);
      expect(payloadDate.getTime()).toBeGreaterThan(0);
    });
  });

  describe('Mock AbsAction', () => {
    let mockAction: AbsAction;

    beforeEach(() => {
      mockAction = createMockAbsAction();
    });

    it('should create mock action with required properties', () => {
      expect(mockAction.requestId).toBeDefined();
      expect(mockAction.act).toBeDefined();
    });

    it('should support custom overrides', () => {
      const customRequestId = 'custom-request-456';
      const customAction = createMockAbsAction({ requestId: customRequestId });
      
      expect(customAction.requestId).toBe(customRequestId);
    });

    it('should have working mock functions', () => {
      expect(typeof mockAction.act).toBe('function');
    });
  });

  describe('Type Safety', () => {
    it('should enforce correct typing for ping events', () => {
      // This test ensures TypeScript compilation works correctly
      const envelope: EventEnvelope<'ping', PingPayload> = createTestPingEnvelope('test');
      
      expect(envelope.name).toBe('ping');
      expect(typeof envelope.payload.message).toBe('string');
      expect(typeof envelope.payload.timestamp).toBe('string');
    });

    it('should enforce correct typing for pong events', () => {
      // This test ensures TypeScript compilation works correctly
      const envelope: EventEnvelope<'pong', PongPayload> = createTestPongEnvelope('reply', 'original');
      
      expect(envelope.name).toBe('pong');
      expect(typeof envelope.payload.reply).toBe('string');
      expect(typeof envelope.payload.originalMessage).toBe('string');
      expect(typeof envelope.payload.timestamp).toBe('string');
    });
  });
});
