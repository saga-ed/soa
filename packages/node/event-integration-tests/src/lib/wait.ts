export interface PollOpts {
    timeoutMs?: number;
    intervalMs?: number;
}

export async function pollUntil<T>(
    fn: () => Promise<T>,
    predicate: (value: T) => boolean,
    opts: PollOpts = {},
): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (predicate(value)) return value;
        } catch (err) {
            lastError = err;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `pollUntil timed out after ${timeoutMs}ms${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}`,
    );
}

export async function waitForReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
    await pollUntil(
        () => fetch(`${baseUrl}/health/ready`),
        (res) => res.ok,
        { timeoutMs, intervalMs: 200 },
    );
}
