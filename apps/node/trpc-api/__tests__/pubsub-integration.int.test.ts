import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from '../src/app-router.js';
import type { TRPCContext } from '../src/trpc.js';
import { ProjectHelper } from '../src/sectors/project/trpc/project-helper.js';
import { RunHelper } from '../src/sectors/run/trpc/run-helper.js';
import { events } from '../src/sectors/pubsub/trpc/events.js';
import { container } from '../src/inversify.config.js';
import { PubSubService, TYPES, ChannelService } from '@saga-ed/soa-pubsub-server';
import type { ILogger } from '@saga-ed/soa-logger';
import type { EventDefinition, ChannelConfig } from '@saga-ed/soa-pubsub-core';
import express from 'express';

describe('Enhanced PubSub Integration Tests', () => {
    let app: express.Application;
    let server: any;

    beforeAll(async () => {
        app = express();

        const logger = container.get<ILogger>('ILogger');
        const pubsubService = container.get<PubSubService>('PubSubService');
        const channelService = container.get<ChannelService>(TYPES.ChannelService);

        // Register events and channels
        pubsubService.registerEvents(events as unknown as Record<string, EventDefinition>);
        const pingpongChannel: ChannelConfig = {
            name: 'pingpong',
            family: 'demo',
            ordered: false,
            maxSubscribers: 100,
            maxEventSize: 1024 * 1024,
            historyRetentionMs: 24 * 60 * 60 * 1000,
            authScope: 'user'
        };
        channelService.registerChannels([pingpongChannel]);

        const projectHelper = new ProjectHelper();
        const runHelper = new RunHelper();

        // Mount tRPC with static router
        app.use(
            '/saga-soa/v1/trpc',
            createExpressMiddleware({
                router: appRouter,
                createContext: (): TRPCContext => ({
                    logger,
                    pubsubService,
                    channelService,
                    projectHelper,
                    runHelper,
                }),
            }),
        );

        // Start the server on a random port
        server = app.listen(0);
    });

    afterAll(() => {
        if (server) {
            server.close();
        }
    });

    describe('Enhanced PubSub Endpoints', () => {
        it('should have all new pubsub endpoints accessible', async () => {
            // Test ping endpoint
            const pingResponse = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.ping')
                .send({
                    message: 'Test ping message',
                    timestamp: new Date().toISOString()
                })
                .expect(200);

            expect(pingResponse.body.result.data.success).toBe(true);
            expect(pingResponse.body.result.data.pingEvent).toBeDefined();

            // Test getEventDefinitions endpoint
            const eventsResponse = await request(app)
                .get('/saga-soa/v1/trpc/pubsub.getEventDefinitions')
                .expect(200);

            expect(eventsResponse.body.result.data.events).toContain('ping:message');
            expect(eventsResponse.body.result.data.events).toContain('pong:response');
            expect(eventsResponse.body.result.data.totalEvents).toBeGreaterThan(0);

            // Test getChannelInfo endpoint
            const channelResponse = await request(app)
                .get('/saga-soa/v1/trpc/pubsub.getChannelInfo')
                .expect(200);

            expect(channelResponse.body.result.data.channel).toBe('pingpong');
            expect(channelResponse.body.result.data.eventTypes).toContain('ping:message');
            expect(channelResponse.body.result.data.eventTypes).toContain('pong:response');

            // Test getServiceStatus endpoint
            const statusResponse = await request(app)
                .get('/saga-soa/v1/trpc/pubsub.getServiceStatus')
                .expect(200);

            expect(statusResponse.body.result.data.status).toBe('running');
            expect(statusResponse.body.result.data.eventsRegistered).toBeGreaterThan(0);
            expect(statusResponse.body.result.data.channels).toContain('pingpong');

            // Test getSubscriptionStats endpoint
            const statsResponse = await request(app)
                .get('/saga-soa/v1/trpc/pubsub.getSubscriptionStats')
                .expect(200);

            expect(statsResponse.body.result.data.connectionStatus).toBe('connected');
            expect(statsResponse.body.result.data.activeChannels).toContain('pingpong');
        });

        it('should handle custom event sending', async () => {
            const customEventResponse = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.sendEvent')
                .send({
                    name: 'ping:message',
                    payload: { message: 'Custom test event', timestamp: new Date().toISOString() },
                    channel: 'pingpong',
                    options: {
                        clientEventId: 'custom-123',
                        correlationId: 'corr-456',
                        immediate: true
                    }
                })
                .expect(200);

            expect(customEventResponse.body.result.data.success).toBe(true);
            expect(customEventResponse.body.result.data.eventId).toBeDefined();
            expect(customEventResponse.body.result.data.message).toContain('Event "ping:message" sent successfully');
        });

        it('should handle subscription management', async () => {
            const subscribeResponse = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.subscribe')
                .send({
                    channel: 'pingpong',
                    eventTypes: ['ping:message', 'pong:response']
                })
                .expect(200);

            expect(subscribeResponse.body.result.data.success).toBe(true);
            expect(subscribeResponse.body.result.data.subscriptionId).toBeDefined();
            expect(subscribeResponse.body.result.data.channel).toBe('pingpong');
            expect(subscribeResponse.body.result.data.eventTypes).toEqual(['ping:message', 'pong:response']);

            const subscriptionId = subscribeResponse.body.result.data.subscriptionId;

            const unsubscribeResponse = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.unsubscribe')
                .send({
                    subscriptionId
                })
                .expect(200);

            expect(unsubscribeResponse.body.result.data.success).toBe(true);
            expect(unsubscribeResponse.body.result.data.subscriptionId).toBe(subscriptionId);
        });

        it('should validate event name format', async () => {
            await request(app)
                .post('/saga-soa/v1/trpc/pubsub.sendEvent')
                .send({
                    name: 'invalid-event-name',
                    payload: { message: 'Test' }
                })
                .expect(400);
        });

        it('should handle multiple rapid ping operations', async () => {
            const startTime = Date.now();
            const promises = [];

            for (let i = 0; i < 5; i++) {
                const payload = {
                    message: `Rapid ping ${i}`,
                    timestamp: new Date().toISOString()
                };

                promises.push(
                    request(app)
                        .post('/saga-soa/v1/trpc/pubsub.ping')
                        .send(payload)
                        .expect(200)
                );
            }

            const responses = await Promise.all(promises);
            const endTime = Date.now();

            responses.forEach((response, index) => {
                expect(response.body.result.data.success).toBe(true);
                expect(response.body.result.data.pingEvent.payload.message).toBe(`Rapid ping ${index}`);
            });

            expect(endTime - startTime).toBeLessThan(5000);
        });

        it('should provide comprehensive ping-pong flow data', async () => {
            const pingPayload = {
                message: 'Comprehensive test message',
                timestamp: new Date().toISOString()
            };

            const response = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.ping')
                .send(pingPayload)
                .expect(200);

            const result = response.body.result.data;

            expect(result.pingEvent.id).toBeDefined();
            expect(result.pingEvent.name).toBe('ping:message');
            expect(result.pingEvent.channel).toBe('pingpong');
            expect(result.pingEvent.payload.message).toBe(pingPayload.message);
            const payloadTime = new Date(result.pingEvent.payload.timestamp).getTime();
            const expectedTime = new Date(pingPayload.timestamp).getTime();
            expect(Math.abs(payloadTime - expectedTime)).toBeLessThan(100);
            expect(result.pingEvent.timestamp).toBeDefined();

            expect(result.success).toBe(true);
            expect(result.message).toContain('Ping sent successfully');
            expect(result.pubsubResult).toBeDefined();
        });
    });

    describe('Error Handling and Edge Cases', () => {
        it('should handle invalid ping payloads gracefully', async () => {
            const invalidPayloads = [
                {},
                { message: '' },
                { message: null },
                { timestamp: 'invalid-timestamp' }
            ];

            for (const payload of invalidPayloads) {
                await request(app)
                    .post('/saga-soa/v1/trpc/pubsub.ping')
                    .send(payload)
                    .expect(400);
            }
        });

        it('should handle malformed subscription requests', async () => {
            await request(app)
                .post('/saga-soa/v1/trpc/pubsub.subscribe')
                .send({
                    eventTypes: ['ping:message']
                })
                .expect(400);
        });

        it('should handle unsubscribe with invalid subscription ID', async () => {
            const response = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.unsubscribe')
                .send({
                    subscriptionId: 'non-existent-id'
                })
                .expect(200);

            expect(response.body.result.data.success).toBe(true);
        });
    });

    describe('Performance and Scalability', () => {
        it('should handle concurrent ping operations', async () => {
            const concurrentCount = 10;
            const startTime = Date.now();

            const promises = Array.from({ length: concurrentCount }, (_, i) =>
                request(app)
                    .post('/saga-soa/v1/trpc/pubsub.ping')
                    .send({
                        message: `Concurrent ping ${i}`,
                        timestamp: new Date().toISOString()
                    })
                    .expect(200)
            );

            const responses = await Promise.all(promises);
            const endTime = Date.now();

            responses.forEach((response, index) => {
                expect(response.body.result.data.success).toBe(true);
                expect(response.body.result.data.pingEvent.payload.message).toBe(`Concurrent ping ${index}`);
            });

            expect(endTime - startTime).toBeLessThan(10000);
            expect(responses).toHaveLength(concurrentCount);
        });

        it('should maintain consistent response structure under load', async () => {
            const responses = await Promise.all(
                Array.from({ length: 5 }, (_, i) =>
                    request(app)
                        .post('/saga-soa/v1/trpc/pubsub.ping')
                        .send({
                            message: `Load test ${i}`,
                            timestamp: new Date().toISOString()
                        })
                        .expect(200)
                )
            );

            responses.forEach(response => {
                const data = response.body.result.data;
                expect(data).toHaveProperty('success');
                expect(data).toHaveProperty('pingEvent');
                expect(data).toHaveProperty('message');
                expect(data).toHaveProperty('pubsubResult');

                expect(data.pingEvent).toHaveProperty('id');
                expect(data.pingEvent).toHaveProperty('name');
                expect(data.pingEvent).toHaveProperty('channel');
                expect(data.pingEvent).toHaveProperty('payload');
                expect(data.pingEvent).toHaveProperty('timestamp');
            });
        });
    });
});
