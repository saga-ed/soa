import type { IncomingMessage } from 'node:http';

/** `/health` and `/health/*` — ALB/ECS probes, kept out of the trace metrics' 5xx rate. */
export function isHealthCheckRequest(req: Pick<IncomingMessage, 'url'>): boolean {
    const path = (req.url ?? '').split('?', 1)[0] ?? '';
    return path === '/health' || path.startsWith('/health/');
}
