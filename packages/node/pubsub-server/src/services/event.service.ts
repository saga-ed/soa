import { inject, injectable } from 'inversify';
import { TYPES } from '../types/index.js';
import type { 
  EventDefinition, 
  EventEnvelope, 
  AbsAction,
  ActionContext,
  CSEEvent,
  SSEEvent,
  EventName
} from '@saga-ed/soa-pubsub-core';
import { isCSEEvent } from '@saga-ed/soa-pubsub-core';
import type { Logger } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

@injectable()
export class EventService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {}

  async validateEvent(
    name: string, 
    payload: any, 
    events: Record<string, EventDefinition>
  ): Promise<{ valid: boolean; eventDef?: EventDefinition; error?: string }> {
    const eventDef = events[name];
    if (!eventDef) {
      return { valid: false, error: `Unknown event: ${name}` };
    }

    // Validate payload schema if provided
    if (eventDef.payloadSchema) {
      try {
        eventDef.payloadSchema.parse(payload);
      } catch (error) {
        return { 
          valid: false, 
          error: `Payload validation failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
        };
      }
    }

    return { valid: true, eventDef };
  }

  async executeAction(
    eventDef: EventDefinition,
    payload: any,
    requestId: string,
    context?: ActionContext
  ): Promise<{ result: any }> {
    // Only CSE events have actions - SSE events are pure data carriers
    if (!isCSEEvent(eventDef)) {
      return { result: undefined };
    }

    try {
      // Check if the action exists (it's now optional)
      if (!eventDef.action) {
        return { result: undefined };
      }

      // Execute the action using the AbsAction interface
      // Pass context if provided, otherwise call with just payload for backward compatibility
      const result = context 
        ? await eventDef.action.act(payload, context)
        : await eventDef.action.act(payload);
      
      this.logger.info('Action executed successfully', { 
        eventName: eventDef.name, 
        result 
      });

      // Add the requestId to the result as required by the new design
      // Create a new object with the result and requestId
      const resultWithRequestId = Object.assign({}, result, { requestId });
      
      return { result: resultWithRequestId };
    } catch (error) {
      this.logger.error('Action execution failed', { 
        eventName: eventDef.name, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
      throw error;
    }
  }

  createEventEnvelope(
    name: string,
    channel: string,
    payload: any,
    meta?: Record<string, any>
  ): EventEnvelope<any> {
    return {
      id: uuidv4(),
      name: name as any,
      channel,
      payload,
      timestamp: new Date().toISOString(),
      meta
    };
  }

  async checkAuthorization(
    eventDef: EventDefinition,
    user: any
  ): Promise<{ authorized: boolean; error?: string }> {
    // For now, all events are authorized
    // Authorization can be implemented at the application level using DI
    return { authorized: true };
  }
} 