import { inject, injectable } from 'inversify';
import { TYPES } from '../types/index.js';
import type { 
  EventDefinition, 
  EventEnvelope,
  EventName
} from '@hipponot/pubsub-core';
import { isCSEEvent } from '@hipponot/pubsub-core';
import type { PubSubAdapter } from '../adapters/base-adapter.js';
import type { 
  Logger,
  SendEventInput,
  SendEventResult,
  ServerCtx
} from '../types/index.js';
import type { EventService } from './event.service.js';
import type { ChannelService } from './channel.service.js';

@injectable()
export class PubSubService {
  private events: Record<string, EventDefinition> = {};
  private subscribers = new Map<string, Set<(event: EventEnvelope) => Promise<void>>>();

  constructor(
    @inject(TYPES.EventService) private eventService: EventService,
    @inject(TYPES.ChannelService) private channelService: ChannelService,
    @inject(TYPES.PubSubAdapter) private adapter: PubSubAdapter,
    @inject(TYPES.Logger) private logger: Logger
  ) {}

  registerEvents(events: Record<string, EventDefinition>): void {
    this.events = { ...this.events, ...events };
    this.logger.info('Events registered', { 
      count: Object.keys(events).length,
      eventNames: Object.keys(events)
    });
  }

  async sendEvent(
    input: SendEventInput,
    ctx: ServerCtx
  ): Promise<SendEventResult> {
    try {
      // Validate the event
      const validation = await this.eventService.validateEvent(
        input.name,
        input.payload,
        this.events
      );

      if (!validation.valid || !validation.eventDef) {
        return {
          status: 'error',
          error: validation.error || 'Event validation failed'
        };
      }

      const eventDef = validation.eventDef;

      // Check authorization
      const authCheck = await this.eventService.checkAuthorization(
        eventDef,
        ctx.user
      );

      if (!authCheck.authorized) {
        return {
          status: 'error',
          error: authCheck.error || 'Authorization failed'
        };
      }

      // Check channel access
      const channelAccess = this.channelService.validateChannelAccess(
        eventDef.channel,
        ctx.user,
        'write'
      );

      if (!channelAccess.allowed) {
        return {
          status: 'error',
          error: channelAccess.error || 'Channel access denied'
        };
      }

      // Create event envelope
      const event = this.eventService.createEventEnvelope(
        input.name,
        eventDef.channel,
        input.payload,
        {
          clientEventId: input.clientEventId,
          correlationId: input.correlationId,
          userId: ctx.user?.id,
          source: 'api'
        }
      );

      // Validate event for channel
      const channelValidation = await this.channelService.validateEventForChannel(
        event,
        eventDef.channel
      );

      if (!channelValidation.valid) {
        return {
          status: 'error',
          error: channelValidation.error || 'Channel validation failed'
        };
      }

      // Execute action if present
      let result: any;

      if (isCSEEvent(eventDef)) {
        // Create action context for dependency injection
        const actionContext = {
          requestId: input.clientEventId || crypto.randomUUID(),
          emitSSE: async (eventName: EventName, payload: any, options?: { 
            channel?: string; 
            correlationId?: string; 
            meta?: Record<string, unknown> 
          }) => {
            await this.emitSSE(eventName, payload, {
              channel: options?.channel || eventDef.channel,
              correlationId: options?.correlationId || input.correlationId,
              meta: options?.meta
            });
          },
          logger: this.logger
        };

        const actionResult = await this.eventService.executeAction(
          eventDef,
          input.payload,
          input.clientEventId || crypto.randomUUID(),
          actionContext
        );
        result = actionResult.result;
      }

      // Publish the main event
      await this.adapter.publish(event);

      this.logger.info('Event sent successfully', {
        eventName: input.name,
        eventId: event.id,
        channel: eventDef.channel,
        hasAction: isCSEEvent(eventDef)
      });

      return {
        status: 'success',
        result,
        emittedEvents: [event]
      };

    } catch (error) {
      this.logger.error('Failed to send event', {
        eventName: input.name,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async subscribe(
    channel: string,
    handler: (event: EventEnvelope) => Promise<void>,
    ctx: ServerCtx
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    // Check channel access
    const channelAccess = this.channelService.validateChannelAccess(
      channel,
      ctx.user,
      'read'
    );

    if (!channelAccess.allowed) {
      throw new Error(channelAccess.error || 'Channel access denied');
    }

    // Check channel limits
    const limitsCheck = await this.channelService.checkChannelLimits(
      channel,
      'subscribe'
    );

    if (!limitsCheck.allowed) {
      throw new Error(limitsCheck.error || 'Channel limits exceeded');
    }

    // Subscribe to the adapter
    const { unsubscribe } = await this.adapter.subscribe(channel, handler);

    // Track local subscribers for potential local optimizations
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    this.subscribers.get(channel)!.add(handler);

    this.logger.info('Subscription created', {
      channel,
      userId: ctx.user?.id,
      subscriberCount: this.subscribers.get(channel)?.size
    });

    return {
      unsubscribe: async () => {
        await unsubscribe();
        this.subscribers.get(channel)?.delete(handler);
        if (this.subscribers.get(channel)?.size === 0) {
          this.subscribers.delete(channel);
        }
        this.logger.info('Subscription removed', { channel });
      }
    };
  }

  async fetchHistory(
    channel: string,
    opts: { since?: string; limit?: number },
    ctx: ServerCtx
  ): Promise<EventEnvelope[]> {
    // Check channel access
    const channelAccess = this.channelService.validateChannelAccess(
      channel,
      ctx.user,
      'read'
    );

    if (!channelAccess.allowed) {
      throw new Error(channelAccess.error || 'Channel access denied');
    }

    // Check if adapter supports history
    if (!this.adapter.fetchHistory) {
      throw new Error('History not supported by this adapter');
    }

    return this.adapter.fetchHistory(channel, opts);
  }

  async health(): Promise<{ healthy: boolean; details?: any }> {
    try {
      const adapterHealth = await this.adapter.health?.();
      return {
        healthy: adapterHealth?.healthy ?? true,
        details: {
          eventCount: Object.keys(this.events).length,
          channelCount: this.channelService.getAllChannels().length,
          subscriberCount: Array.from(this.subscribers.values()).reduce((sum, set) => sum + set.size, 0),
          adapter: adapterHealth?.details
        }
      };
    } catch (error) {
      return {
        healthy: false,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Emit an SSE event directly (used by actions to emit response events)
   * @param eventName - The name of the SSE event to emit
   * @param payload - The event payload
   * @param options - Emission options
   */
  async emitSSE(
    eventName: EventName,
    payload: any,
    options: {
      channel: string;
      correlationId?: string;
      meta?: Record<string, unknown>;
    }
  ): Promise<void> {
    try {
      // Create event envelope for the SSE event
      const envelope = this.eventService.createEventEnvelope(
        eventName,
        options.channel,
        payload,
        {
          correlationId: options.correlationId,
          source: 'action',
          type: 'sse-response',
          ...options.meta
        }
      );

      // Publish the SSE event directly to subscribers
      await this.adapter.publish(envelope);

      this.logger.info('SSE event emitted successfully', {
        eventName,
        eventId: envelope.id,
        channel: options.channel,
        correlationId: options.correlationId
      });
    } catch (error) {
      this.logger.error('Failed to emit SSE event', {
        eventName,
        error: error instanceof Error ? error.message : 'Unknown error',
        channel: options.channel,
        correlationId: options.correlationId
      });
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down PubSub service');
    
    // Clear local subscribers
    this.subscribers.clear();
    
    // Shutdown adapter
    await this.adapter.shutdown?.();
    
    this.logger.info('PubSub service shutdown complete');
  }
} 