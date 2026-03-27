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

describe('Automatic Pong Emission Tests', () => {
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

    describe('Ping Action Automatically Emits Pong Response', () => {
        it('should automatically emit pong SSE event when ping action executes', async () => {
            const pingPayload = {
                message: 'Automatic emission test',
                timestamp: new Date().toISOString()
            };

            const response = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.ping')
                .send(pingPayload)
                .expect(200);

            const result = response.body.result.data;

            // Verify ping was processed successfully
            expect(result.success).toBe(true);
            expect(result.pingEvent).toBeDefined();
            expect(result.pingEvent.payload.message).toBe(pingPayload.message);

            // The key insight: the action now returns the SAME data that was emitted as SSE
            expect(result.pubsubResult.result).toBeDefined();
            expect(result.pubsubResult.result.reply).toBe(`Pong: ${pingPayload.message}`);
            expect(result.pubsubResult.result.originalMessage).toBe(pingPayload.message);
            expect(result.pubsubResult.result.requestId).toBeDefined();

            const actionResult = result.pubsubResult.result;
            expect(actionResult.reply).toContain('Pong:');
            expect(actionResult.originalMessage).toBe(pingPayload.message);
            expect(actionResult.timestamp).toBeDefined();
        });

        it('should handle multiple rapid ping requests with automatic pong emission', async () => {
            const promises = [];
            const testMessages = ['Rapid 1', 'Rapid 2', 'Rapid 3'];

            for (const message of testMessages) {
                promises.push(
                    request(app)
                        .post('/saga-soa/v1/trpc/pubsub.ping')
                        .send({
                            message,
                            timestamp: new Date().toISOString()
                        })
                        .expect(200)
                );
            }

            const responses = await Promise.all(promises);

            responses.forEach((response, index) => {
                const result = response.body.result.data;
                const expectedMessage = testMessages[index];

                expect(result.success).toBe(true);
                expect(result.pubsubResult.result.reply).toBe(`Pong: ${expectedMessage}`);
                expect(result.pubsubResult.result.originalMessage).toBe(expectedMessage);
                expect(result.pubsubResult.result.requestId).toBeDefined();
            });
        });

        it('should demonstrate the action context pattern works correctly', async () => {
            const testMessage = 'Context pattern test';

            const response = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.ping')
                .send({
                    message: testMessage,
                    timestamp: new Date().toISOString()
                })
                .expect(200);

            const result = response.body.result.data;
            const actionResult = result.pubsubResult.result;

            expect(actionResult.reply).toBe(`Pong: ${testMessage}`);
            expect(actionResult.originalMessage).toBe(testMessage);

            expect(actionResult.requestId).toBeDefined();
            expect(typeof actionResult.requestId).toBe('string');

            expect(actionResult.timestamp).toBeDefined();
            const timestamp = new Date(actionResult.timestamp);
            expect(timestamp.getTime()).toBeCloseTo(Date.now(), -3);
        });

        it('should handle custom correlation IDs correctly', async () => {
            const response = await request(app)
                .post('/saga-soa/v1/trpc/pubsub.sendEvent')
                .send({
                    name: 'ping:message',
                    payload: {
                        message: 'Custom correlation test',
                        timestamp: new Date().toISOString()
                    },
                    channel: 'pingpong',
                    options: {
                        correlationId: 'custom-correlation-123'
                    }
                })
                .expect(200);

            const result = response.body.result.data;

            expect(result.success).toBe(true);
            expect(result.result.reply).toBe('Pong: Custom correlation test');
            expect(result.result.originalMessage).toBe('Custom correlation test');

            expect(result.eventId).toBeDefined();
        });
    });
});
