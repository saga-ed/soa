import { Router, type Request, type Response } from 'express';
import { bearerToken, tokensMatch } from './auth.js';
import { buildManifest } from './manifest.js';
import type { AnyEntityDescriptor, InspectConfig } from './types.js';
import { ListQuerySchema } from './wire.js';

function notFound(res: Response): void {
    // Same body whether the surface is unconfigured, the gate is off, or the
    // entity doesn't exist — an unauthorized prober learns nothing.
    res.status(404).json({ error: 'Not found' });
}

function internalError(config: InspectConfig, res: Response, where: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    config.logger?.error(`soa-inspect ${where} failed: ${message}`);
    // The only caller is the trusted console BFF; surfacing the message is
    // what makes the inspector useful against a half-broken service.
    res.status(500).json({ error: message });
}

/**
 * The inspect surface (microservices#662). Mount BEFORE any human-session
 * perimeter (it authenticates with the console's bearer, not a user session):
 *
 *   app.use('/inspect', createInspectRouter({ ... }));
 *
 * Gate semantics (mirrors the iam-api admin-gate house pattern):
 *   - no token configured  → every route 404s (default-off)
 *   - bad/missing bearer   → 401
 *   - per-surface gate off → 404
 */
export function createInspectRouter(config: InspectConfig): Router {
    const router = Router();
    const expected = config.token;

    if (!expected) {
        router.use((_req: Request, res: Response) => notFound(res));
        return router;
    }

    router.use((req: Request, res: Response, next: () => void) => {
        const submitted = bearerToken(req.headers.authorization);
        if (!submitted || !tokensMatch(submitted, expected)) {
            res.status(401).json({ error: 'Invalid inspect credentials' });
            return;
        }
        next();
    });

    // Manifest is metadata-only by design (entity/field names, event keys,
    // gate states) — available to any valid bearer so the console can show
    // *why* a surface is dark instead of a bare 404.
    router.get('/manifest', (_req: Request, res: Response) => {
        res.json(buildManifest(config));
    });

    router.get('/status', (_req: Request, res: Response) => {
        if (!config.gates.status) return notFound(res);
        void (async () => {
            const [outbox, consumers] = await Promise.all([
                config.status?.outbox?.() ?? Promise.resolve(null),
                config.status?.consumers?.() ?? Promise.resolve([]),
            ]);
            res.json({
                service: config.service,
                generatedAt: new Date().toISOString(),
                outbox,
                consumers,
            });
        })().catch((err: unknown) => internalError(config, res, 'status', err));
    });

    const findEntity = (name: string): AnyEntityDescriptor | undefined =>
        config.entities.find((e) => e.name === name);

    router.get('/entities/:entity', (req: Request, res: Response) => {
        if (!config.gates.entities) return notFound(res);
        const descriptor = findEntity(req.params.entity ?? '');
        if (!descriptor) return notFound(res);
        const parsed = ListQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid list query', issues: parsed.error.issues });
            return;
        }
        const query = parsed.data;
        void descriptor
            .list(query)
            .then(({ rows, total }) => {
                res.json({ entity: descriptor.name, rows, total, limit: query.limit, offset: query.offset });
            })
            .catch((err: unknown) => internalError(config, res, `entities/${descriptor.name}`, err));
    });

    router.get('/entities/:entity/:id', (req: Request, res: Response) => {
        if (!config.gates.entities) return notFound(res);
        const descriptor = findEntity(req.params.entity ?? '');
        if (!descriptor?.get) return notFound(res);
        void descriptor
            .get(req.params.id ?? '')
            .then((row) => {
                if (row === null) return notFound(res);
                res.json({ entity: descriptor.name, row });
            })
            .catch((err: unknown) => internalError(config, res, `entities/${descriptor.name}/get`, err));
    });

    // Anything else under the mount answers like the gates-off case.
    router.use((_req: Request, res: Response) => notFound(res));

    return router;
}
