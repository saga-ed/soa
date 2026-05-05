import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import {
    IDENTITY_SVC,
    migrate,
    spawnService,
    type SpawnedService,
} from '../lib/services.js';
import { waitForReady } from '../lib/wait.js';

interface CreatedUser {
    id: string;
    name: string;
    email: string;
    createdAt: string;
}

interface TrpcResult<T> {
    result: { data: T };
}

describe('publisher-edge idempotency (Idempotency-Key)', () => {
    let infra: InfraHandle;
    let identity: SpawnedService;

    beforeAll(async () => {
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('identity_idempotency_test');
        migrate(IDENTITY_SVC, dbUrl);

        identity = spawnService({
            serviceDir: IDENTITY_SVC,
            port: 4011,
            env: {
                NODE_ENV: 'test',
                LOG_LEVEL: 'warn',
                DATABASE_URL: dbUrl,
                RABBITMQ_URL: infra.rabbitmqUrl,
                EVENTS_EXCHANGE: 'identity.events.idempotency-test',
            },
        });
        await waitForReady(identity.baseUrl);
    }, 120_000);

    afterAll(async () => {
        await identity?.stop();
        await infra?.stop();
    });

    it('returns cached response for duplicate Idempotency-Key', async () => {
        const key = 'idem-' + Date.now() + '-' + Math.random();
        const input = { name: 'Ada Lovelace', email: `ada-${Date.now()}@example.com` };

        const first = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': key,
            },
            body: JSON.stringify(input),
        });
        expect(first.ok).toBe(true);
        const firstBody = (await first.json()) as TrpcResult<CreatedUser>;
        const firstUserId = firstBody.result.data.id;
        expect(firstUserId).toBeTruthy();

        // Second request with SAME key but DIFFERENT email — should return the
        // cached response from the first call (same userId, same email).
        // The body input is ignored for cached responses.
        const second = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': key,
            },
            body: JSON.stringify({
                name: 'Different Person',
                email: `diff-${Date.now()}@example.com`,
            }),
        });
        expect(second.ok).toBe(true);
        const secondBody = (await second.json()) as TrpcResult<CreatedUser>;

        // Cached response — same userId as first, NOT a new user.
        expect(secondBody.result.data.id).toBe(firstUserId);
        expect(secondBody.result.data.email).toBe(input.email);
        expect(secondBody.result.data.name).toBe(input.name);
    });

    it('different Idempotency-Keys create distinct users', async () => {
        const k1 = 'idem-a-' + Date.now();
        const k2 = 'idem-b-' + Date.now();

        const r1 = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': k1,
            },
            body: JSON.stringify({
                name: 'A',
                email: `a-${Date.now()}-${Math.random()}@example.com`,
            }),
        });
        const r2 = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': k2,
            },
            body: JSON.stringify({
                name: 'B',
                email: `b-${Date.now()}-${Math.random()}@example.com`,
            }),
        });
        const b1 = (await r1.json()) as TrpcResult<CreatedUser>;
        const b2 = (await r2.json()) as TrpcResult<CreatedUser>;
        expect(b1.result.data.id).not.toBe(b2.result.data.id);
    });

    it('no Idempotency-Key — every request is independent', async () => {
        const stamp = Date.now();
        const r1 = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'C',
                email: `c-${stamp}-${Math.random()}@example.com`,
            }),
        });
        const r2 = await fetch(`${identity.baseUrl}/trpc/users.create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'D',
                email: `d-${stamp}-${Math.random()}@example.com`,
            }),
        });
        const b1 = (await r1.json()) as TrpcResult<CreatedUser>;
        const b2 = (await r2.json()) as TrpcResult<CreatedUser>;
        expect(b1.result.data.id).not.toBe(b2.result.data.id);
    });
});
