import type { ZodType } from 'zod';

export type EventName = `${string}:${string}` | string; // Example: "orders:created" or simple "ping"
export type EventDirection = 'SSE' | 'CSE';

// Event envelope type (defined first to avoid forward references)
export type EventEnvelope<Name extends EventName = EventName, Payload = unknown> = {
    id: string;
    name: Name;
    channel: string;
    payload: Payload;
    timestamp: string;
    meta?: Record<string, unknown>;
};

// Action context interface for dependency injection
export interface ActionContext {
    requestId: string;
    emitSSE: (eventName: EventName, payload: any, options?: { 
        channel?: string; 
        correlationId?: string; 
        meta?: Record<string, unknown> 
    }) => Promise<void>;
    logger?: {
        info(message: string, meta?: any): void;
        error(message: string, meta?: any): void;
        warn(message: string, meta?: any): void;
        debug(message: string, meta?: any): void;
    };
}

// Abstract action interface for events
export interface AbsAction<TResult = void, TResponseEvent extends SSEEvent = SSEEvent> {
    readonly requestId: string;
    readonly responseEventType?: TResponseEvent['name']; // Links to SSE event name
    act(payload: unknown, context?: ActionContext): Promise<TResult>;
}

// Base event interface with common properties
export interface BaseEvent<TPayload = unknown> {
    // Core identification
    name: EventName;
    channel: string;
    
    // Schema validation (optional)
    payloadSchema?: ZodType<TPayload>;
    
    // Metadata
    description?: string;
    version?: number;
    rateLimit?: {
        maxPerMinute?: number;
        maxPerHour?: number;
        maxPerDay?: number;
    };
}

// SSE: Server-Sent Events (pure data carriers, no actions)
export interface SSEEvent<TPayload = unknown> extends BaseEvent<TPayload> {
    direction: 'SSE';
    // No action property - SSE events are pure data carriers
}

// CSE: Client-Sent Events (events with server-side actions)
export interface CSEEvent<TPayload = unknown, TResult = void> extends BaseEvent<TPayload> {
    direction: 'CSE';
    action?: AbsAction<TResult>;
}

// CSE: Client-Sent Events with response events
export interface CSEEventWithResponse<
    TPayload = unknown, 
    TResult = void, 
    TResponseEvent extends SSEEvent<TResult> = SSEEvent<TResult>
> extends BaseEvent<TPayload> {
    direction: 'CSE';
    action?: AbsAction<TResult, TResponseEvent>;
    responseEvent: TResponseEvent; // Required for this type
}

// Discriminated union of all event types
export type Event<TPayload = unknown, TResult = void> =
    | SSEEvent<TPayload>
    | CSEEvent<TPayload, TResult>
    | CSEEventWithResponse<TPayload, TResult>;

// Type alias for backward compatibility
export type EventDefinition<TPayload = unknown, TResult = void> = Event<TPayload, TResult>;

// Type guards for discriminating event types
export function isCSEEvent<TPayload, TResult>(
    event: Event<TPayload, TResult>
): event is CSEEvent<TPayload, TResult> | CSEEventWithResponse<TPayload, TResult> {
    return event.direction === 'CSE';
}

export function isCSEEventWithResponse<TPayload, TResult>(
    event: Event<TPayload, TResult>
): event is CSEEventWithResponse<TPayload, TResult> {
    return event.direction === 'CSE' && 'responseEvent' in event;
}

export function isSSEEvent<TPayload>(event: Event<TPayload>): event is Event<TPayload> & { direction: 'SSE' } {
    return event.direction === 'SSE';
}

// Helper to create event envelopes from definitions
export function createEventEnvelope<TPayload>(
    event: Event<TPayload>,
    payload: TPayload,
    options?: { id?: string; timestamp?: string; meta?: Record<string, unknown> }
): EventEnvelope<EventName, TPayload> {
    return {
        id: options?.id || crypto.randomUUID(),
        name: event.name,
        channel: event.channel,
        payload,
        timestamp: options?.timestamp || new Date().toISOString(),
        meta: options?.meta
    };
}

// Helper to validate event envelope structure
export function isValidEventEnvelope(obj: unknown): obj is EventEnvelope {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        'id' in obj &&
        'name' in obj &&
        'channel' in obj &&
        'payload' in obj &&
        'timestamp' in obj &&
        typeof (obj as Record<string, unknown>).id === 'string' &&
        typeof (obj as Record<string, unknown>).name === 'string' &&
        typeof (obj as Record<string, unknown>).channel === 'string' &&
        typeof (obj as Record<string, unknown>).timestamp === 'string'
    );
}