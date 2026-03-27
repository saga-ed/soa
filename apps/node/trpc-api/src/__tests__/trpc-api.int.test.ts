import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import { appRouter } from '../app-router.js';
import type { AppRouter } from '../app-router.js';
import type { TRPCContext } from '../trpc.js';
import { ProjectHelper } from '../sectors/project/trpc/project-helper.js';
import { RunHelper } from '../sectors/run/trpc/run-helper.js';
import type { ILogger } from '@saga-ed/soa-logger';
import express from 'express';

// Simple no-op logger for tests
const noopLogger: ILogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger,
} as ILogger;

describe('tRPC API Integration Tests', () => {
    let app: express.Application;
    let client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
    let server: any;

    beforeAll(async () => {
        app = express();

        const projectHelper = new ProjectHelper();
        const runHelper = new RunHelper();

        // Mount tRPC with static router directly
        app.use(
            '/saga-soa/v1/trpc',
            createExpressMiddleware({
                router: appRouter,
                createContext: (): TRPCContext => ({
                    logger: noopLogger,
                    pubsubService: null as any,
                    channelService: null as any,
                    projectHelper,
                    runHelper,
                }),
            }),
        );

        // Start the server on a random port
        server = app.listen(0);
        const port = (server.address() as any).port;

        // Create tRPC client
        client = createTRPCProxyClient<AppRouter>({
            links: [
                httpBatchLink({
                    url: `http://localhost:${port}/saga-soa/v1/trpc`,
                }),
            ],
        });
    });

    afterAll(() => {
        if (server) {
            server.close();
        }
    });

    describe('Project Router', () => {
        it('should get all projects', async () => {
            const result = await client.project.getAllProjects.query();
            expect(Array.isArray(result)).toBe(true);
        });

        it('should get project by ID', async () => {
            const result = await client.project.getProjectById.query({ id: '1' });
            expect(result.id).toBe('1');
            expect(result.name).toBe('Saga SOA Platform');
        });

        it('should create a new project', async () => {
            const newProject = {
                name: 'Test Project',
                description: 'A test project',
                status: 'active' as const,
            };

            const result = await client.project.createProject.mutate(newProject);
            expect(result.name).toBe(newProject.name);
            expect(result.description).toBe(newProject.description);
        });
    });

    describe('Run Router', () => {
        it('should get all runs', async () => {
            const result = await client.run.getAllRuns.query();
            expect(Array.isArray(result)).toBe(true);
        });

        it('should get run by ID', async () => {
            const result = await client.run.getRunById.query({ id: '1' });
            expect(result.id).toBe('1');
            expect(result.name).toBe('Initial Build');
        });

        it('should create a new run', async () => {
            const newRun = {
                projectId: '1',
                name: 'Test Run',
                description: 'A test run',
                status: 'pending' as const,
            };

            const result = await client.run.createRun.mutate(newRun);
            expect(result.name).toBe(newRun.name);
            expect(result.projectId).toBe(newRun.projectId);
        });
    });
});
