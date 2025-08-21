import { z } from 'zod';

// ============================================================================
// PubSub Event Schemas - Client/Server Shared Types
// ============================================================================

// Ping message schema for tRPC input validation
export const PingMessageSchema = z.object({
    message: z.string().min(1, 'Message cannot be empty'),
    timestamp: z.string()
});

// Pong response schema for tRPC output types  
export const PongResponseSchema = z.object({
    reply: z.string(),
    originalMessage: z.string(),
    timestamp: z.string()
});

// TypeScript types derived from schemas - these will be available to typegen
export type PingMessageInput = z.infer<typeof PingMessageSchema>;
export type PongResponseOutput = z.infer<typeof PongResponseSchema>;