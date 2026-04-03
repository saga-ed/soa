/**
 * Node.js tRPC Client Example
 *
 * Server-to-server (microservice mesh) client using the vanilla tRPC client.
 * Demonstrates type-safe API calls without any codegen step.
 *
 * Usage:
 *   1. Start the tRPC API server: cd apps/node/trpc-api && pnpm dev
 *   2. Run this example: npx tsx examples/node-client.ts
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@saga-ed/soa-trpc-types';

// Create a type-safe tRPC client for server-to-server communication
const trpc = createTRPCClient<AppRouter>({
    links: [
        httpBatchLink({
            url: 'http://localhost:4003/saga-soa/v1/trpc',
            // Optional: add auth headers for service-to-service auth
            headers: () => ({
                'x-service-name': 'my-service',
                'authorization': `Bearer ${process.env.SERVICE_TOKEN}`,
            }),
        }),
    ],
});

// Usage — fully type-safe, autocomplete on sectors + procedures
async function main() {
    // Query: get all projects
    const projects = await trpc.project.getAllProjects.query();
    console.log('Projects:', projects);

    // Query with input: get project by ID
    const project = await trpc.project.getProjectById.query({ id: '123' });
    console.log('Project:', project);

    // Mutation: create a new project
    const newProject = await trpc.project.createProject.mutate({
        name: 'New Project',
        description: 'Created via Node.js client',
    });
    console.log('Created:', newProject);

    // Run sector: get all runs
    const runs = await trpc.run.getAllRuns.query();
    console.log('Runs:', runs);

    // PubSub sector: get service status
    const status = await trpc.pubsub.getServiceStatus.query();
    console.log('PubSub Status:', status);
}

main().catch(console.error);
