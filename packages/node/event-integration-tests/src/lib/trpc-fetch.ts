/**
 * Minimal tRPC HTTP helpers. We avoid pulling in @trpc/client (and the AppRouter
 * type imports across services) — the wire format is stable enough that hand-rolled
 * fetches are simpler than configuring a full tRPC client per service.
 */

export async function trpcMutate<T>(
    baseUrl: string,
    procedure: string,
    input: unknown,
): Promise<T> {
    const res = await fetch(`${baseUrl}/trpc/${procedure}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`tRPC mutation ${procedure} failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { result: { data: T } };
    return data.result.data;
}

export async function trpcQuery<T>(
    baseUrl: string,
    procedure: string,
    input?: unknown,
): Promise<T> {
    const url = new URL(`${baseUrl}/trpc/${procedure}`);
    if (input !== undefined) {
        url.searchParams.set('input', JSON.stringify(input));
    }
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`tRPC query ${procedure} failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { result: { data: T } };
    return data.result.data;
}
