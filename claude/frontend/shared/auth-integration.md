# Auth Integration Patterns (Framework-Agnostic)

Authentication and authorization patterns for frontend applications.

## Token Management

### Storage

```typescript
// lib/auth.ts
const TOKEN_KEY = 'auth_token';
const REFRESH_KEY = 'refresh_token';

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setTokens(access: string, refresh: string): void {
    localStorage.setItem(TOKEN_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
}

export function clearTokens(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
}
```

### Token Refresh

```typescript
let refreshPromise: Promise<string> | null = null;

export async function getValidToken(): Promise<string> {
    const token = getToken();

    if (!token || isTokenExpired(token)) {
        if (!refreshPromise) {
            refreshPromise = refreshToken().finally(() => {
                refreshPromise = null;
            });
        }
        return refreshPromise;
    }

    return token;
}

async function refreshToken(): Promise<string> {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) throw new Error('No refresh token');

    const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: refresh }),
    });

    if (!response.ok) {
        clearTokens();
        throw new Error('Token refresh failed');
    }

    const { accessToken, refreshToken: newRefresh } = await response.json();
    setTokens(accessToken, newRefresh);
    return accessToken;
}
```

## Protected Routes

### SvelteKit

```typescript
// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
    const token = event.cookies.get('session');

    if (event.url.pathname.startsWith('/dashboard')) {
        if (!token) {
            return new Response(null, {
                status: 302,
                headers: { Location: '/login' },
            });
        }
    }

    return resolve(event);
};
```

### Next.js

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
    const token = request.cookies.get('session');

    if (request.nextUrl.pathname.startsWith('/dashboard')) {
        if (!token) {
            return NextResponse.redirect(new URL('/login', request.url));
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/dashboard/:path*',
};
```

## Auth State Management

### SvelteKit Store

```typescript
// lib/stores/auth.ts
import { writable, derived } from 'svelte/store';

interface AuthState {
    user: User | null;
    loading: boolean;
}

export const auth = writable<AuthState>({ user: null, loading: true });
export const isAuthenticated = derived(auth, ($auth) => !!$auth.user);
```

### React Context

```tsx
// contexts/AuthContext.tsx
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        checkAuth().then(setUser).finally(() => setLoading(false));
    }, []);

    return (
        <AuthContext.Provider value={{ user, loading }}>
            {children}
        </AuthContext.Provider>
    );
}
```

## Security Considerations

1. **Never store tokens in localStorage for sensitive apps** - Use httpOnly cookies
2. **Always validate tokens server-side** - Don't trust client validation alone
3. **Implement CSRF protection** - Use SameSite cookies or CSRF tokens
4. **Short token expiry** - Access tokens should expire in 15-60 minutes
