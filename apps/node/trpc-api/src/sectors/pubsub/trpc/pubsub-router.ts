import { router, publicProcedure } from '../../../trpc.js';
import { events, createPingEnvelope } from './events.js';
import { PingMessageSchema } from './schema/pubsub-schemas.js';
import type { EventName } from '@saga-ed/soa-pubsub-core';
import { z } from 'zod';

export const pubsubRouter = router({
    // Send a ping message and get automatic pong response via pubsub
    ping: publicProcedure
        .input(PingMessageSchema)
        .mutation(async ({ ctx, input }) => {
            try {
                // Create ping event envelope
                const pingEnvelope = createPingEnvelope(input.message);

                // Send the ping event via pubsub service
                const result = await ctx.pubsubService.sendEvent(
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
                            logger: ctx.logger,
                            idempotency: null
                        }
                    }
                );

                if (result.status === 'error') {
                    throw new Error(result.error || 'Failed to send ping event');
                }

                return {
                    success: true,
                    pingEvent: pingEnvelope,
                    message: `Ping sent successfully: "${input.message}"`,
                    pubsubResult: result
                };
            } catch (error) {
                ctx.logger.error('Failed to send ping event', error instanceof Error ? error : new Error('Unknown error'), { input });
                throw new Error(`Failed to send ping: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }),

    // Send a custom event via pubsub
    sendEvent: publicProcedure
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
        .mutation(async ({ ctx, input }) => {
            try {
                const eventName = input.name as EventName;

                const result = await ctx.pubsubService.sendEvent(
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
                            logger: ctx.logger,
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
                ctx.logger.error('Failed to send custom event', error instanceof Error ? error : undefined, {
                    input
                });
                throw new Error(`Failed to send event: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }),

    // Get event definitions for this sector
    getEventDefinitions: publicProcedure.query(() => {
        return {
            events: Object.keys(events),
            pingEvent: events['ping:message'],
            pongEvent: events['pong:response'],
            totalEvents: Object.keys(events).length
        };
    }),

    // Get channel information
    getChannelInfo: publicProcedure.query(() => {
        return {
            channel: 'pingpong',
            eventTypes: ['ping:message', 'pong:response'],
            description: 'Ping-pong demonstration channel for CSE/SSE testing',
            activeSubscribers: 0 // TODO: Get from pubsub service
        };
    }),

    // Get pubsub service status
    getServiceStatus: publicProcedure.query(() => {
        return {
            status: 'running',
            eventsRegistered: Object.keys(events).length,
            channels: ['pingpong', 'default'],
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        };
    }),

    // Subscribe to a channel (for SSE events)
    subscribe: publicProcedure
        .input(z.object({
            channel: z.string(),
            eventTypes: z.array(z.string()).optional()
        }))
        .mutation(async ({ ctx, input }) => {
            try {
                const subscriptionId = crypto.randomUUID();

                ctx.logger.info('Subscription request received', {
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
                ctx.logger.error('Failed to create subscription', error instanceof Error ? error : undefined, {
                    input
                });
                throw new Error(`Failed to subscribe: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }),

    // Unsubscribe from a channel
    unsubscribe: publicProcedure
        .input(z.object({
            subscriptionId: z.string()
        }))
        .mutation(async ({ ctx, input }) => {
            try {
                ctx.logger.info('Unsubscribe request received', {
                    subscriptionId: input.subscriptionId
                });

                return {
                    success: true,
                    subscriptionId: input.subscriptionId,
                    message: 'Subscription removed successfully',
                    timestamp: new Date().toISOString()
                };
            } catch (error) {
                ctx.logger.error('Failed to unsubscribe', error instanceof Error ? error : undefined, {
                    input
                });
                throw new Error(`Failed to unsubscribe: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }),

    // Get subscription statistics
    getSubscriptionStats: publicProcedure.query(() => {
        return {
            totalSubscriptions: 0, // TODO: Get from pubsub service
            activeChannels: ['pingpong'],
            connectionStatus: 'connected',
            lastActivity: new Date().toISOString()
        };
    })
});
