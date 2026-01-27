import type { EventEnvelope, CSEEvent, SSEEvent, CSEEventWithResponse, ActionContext } from '@saga-ed/soa-pubsub-core';
import {
    PingMessageSchema,
    PongResponseSchema,
    type PingMessageZ,
    type PongResponseZ
} from './schema/pubsub-schemas.js';

// ============================================================================
// Event Definitions
// ============================================================================

// Pong event definition (SSE - Server-Sent Event) - defined first for reference
export const pongEvent: SSEEvent<PongResponseZ> = {
    name: 'pong:response' as const,
    channel: 'pingpong',
    payloadSchema: PongResponseSchema,
    direction: 'SSE',
    description: 'Pong response sent automatically when a ping is received',
    version: 1
    // No action needed for SSE events - clean separation!
};

// Ping event definition (CSE - Client-Sent Event with Response)
export const pingEvent: CSEEventWithResponse<PingMessageZ, PongResponseZ, typeof pongEvent> = {
    name: 'ping:message' as const,
    channel: 'pingpong',
    payloadSchema: PingMessageSchema,
    direction: 'CSE',
    description: 'Ping message that triggers a pong response',
    version: 1,
    responseEvent: pongEvent, // Links to the expected response event
    action: {
        requestId: crypto.randomUUID(),
        responseEventType: 'pong:response', // Type-safe linkage
        async act(payload: PingMessageZ, context?: ActionContext): Promise<PongResponseZ> {
            // Create pong response
            const pongResponse: PongResponseZ = {
                reply: `Pong: ${payload.message}`,
                originalMessage: payload.message,
                timestamp: new Date().toISOString()
            };

            // If context is provided, automatically emit the pong SSE event
            if (context) {
                try {
                    await context.emitSSE('pong:response', pongResponse, {
                        channel: 'pingpong',
                        correlationId: context.requestId
                    });
                    
                    context.logger?.info('Pong SSE event emitted successfully', {
                        requestId: context.requestId,
                        originalMessage: payload.message,
                        reply: pongResponse.reply
                    });
                } catch (error) {
                    context.logger?.error('Failed to emit pong SSE event', {
                        error: error instanceof Error ? error.message : 'Unknown error',
                        requestId: context.requestId
                    });
                    // Don't throw here - we still want to return the result
                    // The action succeeded even if SSE emission failed
                }
            }

            // Return the response data (this is also what gets stored in the action result)
            return pongResponse;
        }
    }
};

// Log event definition (CSE without response - fire-and-forget)
export const logEvent: CSEEvent<{ message: string; level: string }> = {
    name: 'system:log' as const,
    channel: 'system',
    direction: 'CSE',
    description: 'System log event for fire-and-forget logging',
    version: 1,
    action: {
        requestId: crypto.randomUUID(),
        async act(payload: { message: string; level: string }, context?: ActionContext) {
            // Fire-and-forget action - just log and return void
            const logMessage = `[${payload.level}] ${payload.message}`;
            
            // Use context logger if available, otherwise fall back to console
            if (context?.logger) {
                context.logger.info('System log event processed', {
                    level: payload.level,
                    message: payload.message,
                    requestId: context.requestId
                });
            } else {
                console.log(logMessage);
            }
            // No response event expected
        }
    }
};

// Export all events
export const events = {
    "ping:message": pingEvent,
    "pong:response": pongEvent,
    "system:log": logEvent
};

// ============================================================================
// Helper Functions
// ============================================================================

export const createPingEnvelope = (message: string): EventEnvelope<'ping:message', PingMessageZ> => ({
    id: crypto.randomUUID(),
    name: 'ping:message' as const,
    channel: 'pingpong' as const,
    payload: {
        message,
        timestamp: new Date().toISOString()
    },
    timestamp: new Date().toISOString()
});

export const createPongEnvelope = (reply: string, originalMessage: string): EventEnvelope<'pong:response', PongResponseZ> => ({
    id: crypto.randomUUID(),
    name: 'pong:response' as const,
    channel: 'pingpong' as const,
    payload: {
        reply,
        originalMessage,
        timestamp: new Date().toISOString()
    },
    timestamp: new Date().toISOString()
});
