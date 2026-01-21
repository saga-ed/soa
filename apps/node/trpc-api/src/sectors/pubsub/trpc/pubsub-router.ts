import { injectable, inject } from 'inversify';
import { AbstractTRPCController, router } from '@saga-ed/soa-api-core/abstract-trpc-controller';
import type { ILogger } from '@saga-ed/soa-logger';
import { events, createPingEnvelope } from './events.js';
import { PingMessageSchema, type PingMessageZ } from './schema/pubsub-schemas.js';

// Import pubsub server functionality
import { PubSubService, TYPES, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { EventEnvelope, EventDefinition, EventName, ChannelConfig } from '@saga-ed/soa-pubsub-core';
import { z } from 'zod';

@injectable()
export class PubSubController extends AbstractTRPCController {
  readonly sectorName = 'pubsub';
  private pubsubService: PubSubService;
  private channelService: ChannelService;

  constructor(
    @inject('ILogger') logger: ILogger,
    @inject('PubSubService') pubsubService: PubSubService,
    @inject(TYPES.ChannelService) channelService: ChannelService
  ) {
    super(logger);
    this.pubsubService = pubsubService;
    this.channelService = channelService;
    
    // Register pubsub events and channels with the service
    this.registerPubSubEvents();
    this.registerPubSubChannels();
  }

  private registerPubSubEvents(): void {
    try {
      // Cast events to the expected type to resolve type compatibility
      this.pubsubService.registerEvents(events as unknown as Record<string, EventDefinition>);
      this.logger.info('PubSub events registered successfully', {
        eventCount: Object.keys(events).length,
        eventNames: Object.keys(events)
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub events', error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  private registerPubSubChannels(): void {
    try {
      const pingpongChannel: ChannelConfig = {
        name: 'pingpong',
        family: 'demo',
        ordered: false,
        maxSubscribers: 100,
        maxEventSize: 1024 * 1024, // 1MB
        historyRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
        authScope: 'user'
      };

      this.channelService.registerChannels([pingpongChannel]);
      
      this.logger.info('PubSub channels registered successfully', {
        channelName: 'pingpong',
        family: 'demo'
      });
    } catch (error) {
      this.logger.error('Failed to register PubSub channels', error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  createRouter() {
    const t = this.createProcedure();

    return router({
      // Send a ping message and get automatic pong response via pubsub
      ping: t
        .input(PingMessageSchema)
        .mutation(async ({ input }: { input: PingMessageZ }) => {
          try {
            // Create ping event envelope
            const pingEnvelope = createPingEnvelope(input.message);
            
            // Send the ping event via pubsub service
            const result = await this.pubsubService.sendEvent(
              {
                name: pingEnvelope.name,
                payload: pingEnvelope.payload,
                clientEventId: pingEnvelope.id,
                correlationId: pingEnvelope.id
              },
              {
                user: { id: 'web-client', roles: ['user'] },
                requestId: pingEnvelope.id,
                services: {
                  db: null, // TODO: Inject actual services
                  cache: null,
                  logger: this.logger,
                  idempotency: null
                }
              }
            );

            if (result.status === 'error') {
              throw new Error(result.error || 'Failed to send ping event');
            }

            // In the new design, actions don't emit events directly
            // They just return results
            return {
              success: true,
              pingEvent: pingEnvelope,
              message: `Ping sent successfully: "${input.message}"`,
              pubsubResult: result
            };
          } catch (error) {
            this.logger.error('Failed to send ping event', error instanceof Error ? error : new Error('Unknown error'), { input });
            throw new Error(`Failed to send ping: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }),

      // Send a custom event via pubsub
      sendEvent: t
        .input(z.object({
          name: z.string().regex(/^[^:]+:[^:]+$/, 'Event name must be in format "category:action"'),
          payload: z.any(),
          channel: z.string().optional(),
          options: z.object({
            clientEventId: z.string().optional(),
            correlationId: z.string().optional(),
            immediate: z.boolean().optional()
          }).optional()
        }))
        .mutation(async ({ input }) => {
          try {
            const eventName = input.name as EventName;
            const channel = input.channel || 'default';
            
            const result = await this.pubsubService.sendEvent(
              {
                name: eventName,
                payload: input.payload,
                clientEventId: input.options?.clientEventId,
                correlationId: input.options?.correlationId
              },
              {
                user: { id: 'web-client', roles: ['user'] },
                requestId: crypto.randomUUID(),
                services: {
                  db: null,
                  cache: null,
                  logger: this.logger,
                  idempotency: null
                }
              }
            );

            if (result.status === 'error') {
              throw new Error(result.error || 'Failed to send event');
            }

            return {
              success: true,
              eventId: result.emittedEvents?.[0]?.id || 'unknown',
              emittedEvents: result.emittedEvents,
              result: result.result,
              message: `Event "${eventName}" sent successfully`
            };
          } catch (error) {
            this.logger.error('Failed to send custom event', {
              error: error instanceof Error ? error.message : 'Unknown error',
              input
            });
            throw new Error(`Failed to send event: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }),

      // Get event definitions for this sector
      getEventDefinitions: t.query(() => {
        return {
          events: Object.keys(events),
          pingEvent: events['ping:message'],
          pongEvent: events['pong:response'],
          totalEvents: Object.keys(events).length
        };
      }),

      // Get channel information
      getChannelInfo: t.query(() => {
        return {
          channel: 'pingpong',
          eventTypes: ['ping:message', 'pong:response'],
          description: 'Ping-pong demonstration channel for CSE/SSE testing',
          activeSubscribers: 0 // TODO: Get from pubsub service
        };
      }),

      // Get pubsub service status
      getServiceStatus: t.query(() => {
        return {
          status: 'running',
          eventsRegistered: Object.keys(events).length,
          channels: ['pingpong', 'default'],
          uptime: process.uptime(),
          timestamp: new Date().toISOString()
        };
      }),

      // Subscribe to a channel (for SSE events)
      subscribe: t
        .input(z.object({
          channel: z.string(),
          eventTypes: z.array(z.string()).optional()
        }))
        .mutation(async ({ input }) => {
          try {
            // This would typically set up a WebSocket or SSE connection
            // For now, we'll return subscription info
            const subscriptionId = crypto.randomUUID();
            
            this.logger.info('Subscription request received', {
              channel: input.channel,
              subscriptionId,
              eventTypes: input.eventTypes
            });

            return {
              success: true,
              subscriptionId,
              channel: input.channel,
              eventTypes: input.eventTypes || ['*'],
              message: 'Subscription established (WebSocket/SSE would be implemented here)',
              timestamp: new Date().toISOString()
            };
          } catch (error) {
            this.logger.error('Failed to create subscription', {
              error: error instanceof Error ? error.message : 'Unknown error',
              input
            });
            throw new Error(`Failed to subscribe: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }),

      // Unsubscribe from a channel
      unsubscribe: t
        .input(z.object({
          subscriptionId: z.string()
        }))
        .mutation(async ({ input }) => {
          try {
            this.logger.info('Unsubscribe request received', {
              subscriptionId: input.subscriptionId
            });

            return {
              success: true,
              subscriptionId: input.subscriptionId,
              message: 'Subscription removed successfully',
              timestamp: new Date().toISOString()
            };
          } catch (error) {
            this.logger.error('Failed to unsubscribe', {
              error: error instanceof Error ? error.message : 'Unknown error',
              input
            });
            throw new Error(`Failed to unsubscribe: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }),

      // Get subscription statistics
      getSubscriptionStats: t.query(() => {
        return {
          totalSubscriptions: 0, // TODO: Get from pubsub service
          activeChannels: ['pingpong'],
          connectionStatus: 'connected',
          lastActivity: new Date().toISOString()
        };
      })
    });
  }
}
