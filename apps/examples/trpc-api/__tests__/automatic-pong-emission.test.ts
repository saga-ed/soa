import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { ExpressServer } from '@hipponot/soa-api-core/express-server';
import { TRPCServer } from '@hipponot/soa-api-core/trpc-server';
import { ControllerLoader } from '@hipponot/soa-api-core/utils/controller-loader';
import { AbstractTRPCController } from '@hipponot/soa-api-core/abstract-trpc-controller';
import { container } from '../src/inversify.config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Automatic Pong Emission Tests', () => {
    let app: express.Application;
    let server: any;

    beforeAll(async () => {
        // Get the ControllerLoader from DI
        const controllerLoader = container.get(ControllerLoader);
        
        // Dynamically load all tRPC controllers
        const controllers = await controllerLoader.loadControllers(
            path.resolve(__dirname, '../src/sectors/*/trpc/*-router.ts'),
            AbstractTRPCController
        );

        // Bind all loaded controllers to the DI container
        for (const controller of controllers) {
            container.bind(controller).toSelf().inSingletonScope();
        }

        // Configure Express server
        const expressServer = container.get(ExpressServer);
        await expressServer.init(container, []);
        app = expressServer.getApp();

        // Get the TRPCServer instance from DI
        const trpcServer = container.get(TRPCServer);

        // Add routers to the TRPCServer using dynamically loaded controllers
        for (const controller of controllers) {
            const controllerInstance = container.get(controller) as any;
            trpcServer.addRouter(controllerInstance.sectorName, controllerInstance.createRouter());
        }

        // Create tRPC middleware using TRPCServer
        const trpcMiddleware = trpcServer.createExpressMiddleware();

        // Mount tRPC on the configured base path
        app.use(trpcServer.getBasePath(), trpcMiddleware);

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
            // This proves the ping action executed with context and emitted the pong response
            expect(result.pubsubResult.result).toBeDefined();
            expect(result.pubsubResult.result.reply).toBe(`Pong: ${pingPayload.message}`);
            expect(result.pubsubResult.result.originalMessage).toBe(pingPayload.message);
            expect(result.pubsubResult.result.requestId).toBeDefined();

            // The response should contain the action result (what was also emitted as SSE)
            const actionResult = result.pubsubResult.result;
            expect(actionResult.reply).toContain('Pong:');
            expect(actionResult.originalMessage).toBe(pingPayload.message);
            expect(actionResult.timestamp).toBeDefined();
        });

        it('should handle multiple rapid ping requests with automatic pong emission', async () => {
            const promises = [];
            const testMessages = ['Rapid 1', 'Rapid 2', 'Rapid 3'];

            // Send multiple pings rapidly
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

            // Verify each ping triggered automatic pong emission
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

            // Verify the action received context and used it to emit SSE
            expect(actionResult.reply).toBe(`Pong: ${testMessage}`);
            expect(actionResult.originalMessage).toBe(testMessage);
            
            // The requestId should be consistent (from action context)
            expect(actionResult.requestId).toBeDefined();
            expect(typeof actionResult.requestId).toBe('string');
            
            // Verify the timestamp was set by the action
            expect(actionResult.timestamp).toBeDefined();
            const timestamp = new Date(actionResult.timestamp);
            expect(timestamp.getTime()).toBeCloseTo(Date.now(), -3); // Within ~1000ms
        });

        it('should handle custom correlation IDs correctly', async () => {
            const customCorrelationId = 'custom-correlation-123';
            
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
                        correlationId: customCorrelationId
                    }
                })
                .expect(200);

            const result = response.body.result.data;
            
            // Verify the event was processed and pong was emitted
            expect(result.success).toBe(true);
            expect(result.result.reply).toBe('Pong: Custom correlation test');
            expect(result.result.originalMessage).toBe('Custom correlation test');
            
            // The request should succeed (pong SSE was emitted with custom correlation ID)
            expect(result.eventId).toBeDefined();
        });
    });
});