/**
 * Web/React tRPC Client Example
 *
 * Browser client using @trpc/client with optional TanStack React Query integration.
 * Demonstrates the recommended tRPC v11 pattern for React apps.
 *
 * This file is a reference example — not meant to be executed directly.
 * Copy the relevant sections into your React/Vite/Next.js application.
 */

// ---------------------------------------------------------------------------
// Part 1: Vanilla tRPC client (works in any browser environment)
// ---------------------------------------------------------------------------
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@saga-ed/soa-trpc-types';

export const trpc = createTRPCClient<AppRouter>({
    links: [
        httpBatchLink({
            url: '/saga-soa/v1/trpc', // relative URL, proxied in dev
            headers: () => {
                const token = localStorage.getItem('auth_token');
                return token ? { authorization: `Bearer ${token}` } : {};
            },
        }),
    ],
});

// ---------------------------------------------------------------------------
// Part 2: TanStack React Query integration (recommended for React apps)
// ---------------------------------------------------------------------------
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient();

export const trpcOptions = createTRPCOptionsProxy<AppRouter>({
    client: trpc,
    queryClient,
});

// ---------------------------------------------------------------------------
// Part 3: Usage in a React component
// ---------------------------------------------------------------------------
import { useQuery, useMutation } from '@tanstack/react-query';

function ProjectList() {
    // Type-safe query — autocomplete on procedure name and return type
    const { data: projects, isLoading } = useQuery(
        trpcOptions.project.getAllProjects.queryOptions()
    );

    // Type-safe mutation — input is validated against the Zod schema
    const createProject = useMutation(
        trpcOptions.project.createProject.mutationOptions()
    );

    if (isLoading) return <div>Loading...</div>;

    return (
        <div>
            <h1>Projects</h1>
            {projects?.map((p: any) => (
                <div key={p.id}>{p.name}</div>
            ))}
            <button onClick={() => createProject.mutate({ name: 'New Project' })}>
                Create Project
            </button>
        </div>
    );
}

export default ProjectList;
