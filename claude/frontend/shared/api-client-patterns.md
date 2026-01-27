# API Client Patterns (Framework-Agnostic)

Patterns for consuming backend APIs from frontend applications.

## tRPC Client

Preferred for type-safe API calls when backend uses tRPC.

### Setup

```typescript
// lib/trpc.ts
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@saga-ed/trpc-api';

export const trpc = createTRPCProxyClient<AppRouter>({
    links: [
        httpBatchLink({
            url: `${import.meta.env.VITE_API_URL}/trpc`,
            headers: () => ({
                Authorization: `Bearer ${getToken()}`,
            }),
        }),
    ],
});
```

### Usage

```typescript
// Queries
const users = await trpc.user.list.query();
const user = await trpc.user.getById.query({ id: '123' });

// Mutations
const newUser = await trpc.user.create.mutate({ name: 'John' });
```

## Fetch API

For REST endpoints or when tRPC isn't available.

### Base Client

```typescript
// lib/api.ts
const API_URL = import.meta.env.VITE_API_URL;

export async function apiClient<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const url = `${API_URL}${endpoint}`;

    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${getToken()}`,
            ...options.headers,
        },
    });

    if (!response.ok) {
        throw new ApiError(response.status, await response.text());
    }

    return response.json();
}
```

### Usage

```typescript
// GET
const users = await apiClient<User[]>('/api/users');

// POST
const user = await apiClient<User>('/api/users', {
    method: 'POST',
    body: JSON.stringify({ name: 'John' }),
});
```

## Error Handling

```typescript
class ApiError extends Error {
    constructor(
        public status: number,
        public body: string
    ) {
        super(`API Error ${status}: ${body}`);
    }
}

// Usage
try {
    const data = await apiClient('/api/data');
} catch (error) {
    if (error instanceof ApiError) {
        if (error.status === 401) {
            // Redirect to login
        } else if (error.status === 404) {
            // Show not found
        }
    }
    throw error;
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend API base URL (SvelteKit/Vite) |
| `NEXT_PUBLIC_API_URL` | Backend API base URL (Next.js) |

## See Also

- `auth-integration.md` - Token management and auth flows
