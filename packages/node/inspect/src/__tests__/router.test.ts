import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInspectRouter } from '../router.js';
import { defineEntity, type InspectConfig } from '../types.js';
import { EntityListResponseSchema, InspectManifestSchema, InspectStatusResponseSchema } from '../wire.js';

const TOKEN = 'test-inspect-token';

const userRows = [
    { id: 'u1', username: 'alice@example.org', status: 'ACTIVE' },
    { id: 'u2', username: 'bob@example.org', status: 'SUSPENDED' },
];

function usersEntity() {
    return defineEntity({
        name: 'users',
        displayName: 'Users',
        schema: z.object({
            id: z.string(),
            username: z.string(),
            status: z.string(),
        }),
        pii: ['username'],
        searchFields: ['username'],
        list: async ({ limit, offset }) => ({ rows: userRows.slice(offset, offset + limit), total: userRows.length }),
        get: async (id) => userRows.find((u) => u.id === id) ?? null,
    });
}

function appWith(overrides: Partial<InspectConfig> = {}) {
    const config: InspectConfig = {
        service: 'test-api',
        entities: [usersEntity()],
        token: TOKEN,
        gates: { entities: true, status: true },
        ...overrides,
    };
    const app = express();
    app.use('/inspect', createInspectRouter(config));
    return app;
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('createInspectRouter — gate semantics', () => {
    it('404s every route when no token is configured, even with a bearer', async () => {
        const app = appWith({ token: undefined });
        for (const path of ['/inspect/manifest', '/inspect/status', '/inspect/entities/users']) {
            const res = await request(app).get(path).set(auth);
            expect(res.status).toBe(404);
        }
    });

    it('401s a wrong or missing bearer when the token is configured', async () => {
        const app = appWith();
        expect((await request(app).get('/inspect/manifest')).status).toBe(401);
        expect(
            (await request(app).get('/inspect/manifest').set({ Authorization: 'Bearer nope' })).status,
        ).toBe(401);
    });

    it('404s entity routes when the entities gate is off (manifest still serves)', async () => {
        const app = appWith({ gates: { entities: false, status: true } });
        expect((await request(app).get('/inspect/entities/users').set(auth)).status).toBe(404);
        const manifest = await request(app).get('/inspect/manifest').set(auth);
        expect(manifest.status).toBe(200);
        expect(manifest.body.gates).toEqual({ entities: false, status: true });
    });

    it('404s status when the status gate is off', async () => {
        const app = appWith({ gates: { entities: true, status: false } });
        expect((await request(app).get('/inspect/status').set(auth)).status).toBe(404);
    });

    it('404s unknown paths under the mount', async () => {
        const app = appWith();
        expect((await request(app).get('/inspect/nope').set(auth)).status).toBe(404);
    });
});

describe('createInspectRouter — manifest', () => {
    it('serves a schema-valid manifest with field, pii, and capability info', async () => {
        const app = appWith({
            events: { exchange: 'test.events', published: ['test.thing.created.v1'], consumerNames: [] },
        });
        const res = await request(app).get('/inspect/manifest').set(auth);
        expect(res.status).toBe(200);
        const manifest = InspectManifestSchema.parse(res.body);
        expect(manifest.service).toBe('test-api');
        const users = manifest.entities.find((e) => e.name === 'users');
        expect(users?.supportsGet).toBe(true);
        expect(users?.fields.find((f) => f.name === 'username')?.pii).toBe(true);
        expect(users?.fields.find((f) => f.name === 'id')?.pii).toBe(false);
        expect(manifest.events?.exchange).toBe('test.events');
    });
});

describe('createInspectRouter — entities', () => {
    it('lists rows with paging defaults and a schema-valid response', async () => {
        const res = await request(appWith()).get('/inspect/entities/users').set(auth);
        expect(res.status).toBe(200);
        const body = EntityListResponseSchema.parse(res.body);
        expect(body.total).toBe(2);
        expect(body.rows).toHaveLength(2);
        expect(body.limit).toBe(50);
    });

    it('clamps limit via 400 rather than silently truncating', async () => {
        const res = await request(appWith()).get('/inspect/entities/users?limit=9999').set(auth);
        expect(res.status).toBe(400);
    });

    it('passes paging through to the descriptor', async () => {
        const res = await request(appWith()).get('/inspect/entities/users?limit=1&offset=1').set(auth);
        expect(res.body.rows).toEqual([userRows[1]]);
        expect(res.body.total).toBe(2);
    });

    it('gets a row by id and 404s a miss', async () => {
        const app = appWith();
        const hit = await request(app).get('/inspect/entities/users/u1').set(auth);
        expect(hit.status).toBe(200);
        expect(hit.body.row.id).toBe('u1');
        expect((await request(app).get('/inspect/entities/users/zzz').set(auth)).status).toBe(404);
    });

    it('404s an unknown entity and an entity without get()', async () => {
        const noGet = defineEntity({
            name: 'plain',
            schema: z.object({ id: z.string() }),
            list: async () => ({ rows: [], total: 0 }),
        });
        const app = appWith({ entities: [noGet] });
        expect((await request(app).get('/inspect/entities/unknown').set(auth)).status).toBe(404);
        expect((await request(app).get('/inspect/entities/plain/x').set(auth)).status).toBe(404);
    });

    it('500s with the underlying message when a descriptor throws', async () => {
        const broken = defineEntity({
            name: 'broken',
            schema: z.object({ id: z.string() }),
            list: async () => {
                throw new Error('db is down');
            },
        });
        const res = await request(appWith({ entities: [broken] })).get('/inspect/entities/broken').set(auth);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('db is down');
    });
});

describe('createInspectRouter — status', () => {
    it('reports provider results in a schema-valid response', async () => {
        const app = appWith({
            status: {
                outbox: async () => ({ headOccurredAt: '2026-06-10T00:00:00.000Z', headPosition: '42' }),
                consumers: async () => [
                    { consumerName: 'test.iam-projection', lastProcessedAt: null, consumedCount: 0 },
                ],
            },
        });
        const res = await request(app).get('/inspect/status').set(auth);
        expect(res.status).toBe(200);
        const body = InspectStatusResponseSchema.parse(res.body);
        expect(body.outbox?.headPosition).toBe('42');
        expect(body.consumers[0]?.consumerName).toBe('test.iam-projection');
    });

    it('defaults to no outbox / no consumers when no providers are wired', async () => {
        const res = await request(appWith()).get('/inspect/status').set(auth);
        expect(res.body.outbox).toBeNull();
        expect(res.body.consumers).toEqual([]);
    });
});
