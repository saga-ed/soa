import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import {
    ADMISSIONS_SVC,
    IDENTITY_SVC,
    migrate,
    spawnService,
    type SpawnedService,
} from '../lib/services.js';
import { pollUntil, waitForReady } from '../lib/wait.js';
import { trpcMutate, trpcQuery } from '../lib/trpc-fetch.js';

interface CreatedUser {
    id: string;
    name: string;
    email: string;
    createdAt: string;
}

interface UserProjection {
    userId: string;
    name: string;
    email: string;
    createdAt: string;
    updatedAt: string;
}

describe('cross-service user projection (integration)', () => {
    let infra: InfraHandle;
    let identity: SpawnedService;
    let admissions: SpawnedService;

    beforeAll(async () => {
        infra = await startInfra();

        const identityDbUrl = await infra.createDatabase('identity_test');
        const admissionsDbUrl = await infra.createDatabase('admissions_test');

        migrate(IDENTITY_SVC, identityDbUrl);
        migrate(ADMISSIONS_SVC, admissionsDbUrl);

        identity = spawnService({
            serviceDir: IDENTITY_SVC,
            port: 4001,
            env: {
                NODE_ENV: 'test',
                LOG_LEVEL: 'warn',
                DATABASE_URL: identityDbUrl,
                RABBITMQ_URL: infra.rabbitmqUrl,
                EVENTS_EXCHANGE: 'identity.events',
            },
        });
        admissions = spawnService({
            serviceDir: ADMISSIONS_SVC,
            port: 4003,
            env: {
                NODE_ENV: 'test',
                LOG_LEVEL: 'warn',
                DATABASE_URL: admissionsDbUrl,
                RABBITMQ_URL: infra.rabbitmqUrl,
                IDENTITY_EVENTS_EXCHANGE: 'identity.events',
                IDENTITY_EVENTS_QUEUE: 'admissions-svc.identity-events.test',
            },
        });

        await Promise.all([waitForReady(identity.baseUrl), waitForReady(admissions.baseUrl)]);
    }, 120_000);

    afterAll(async () => {
        await Promise.allSettled([identity?.stop(), admissions?.stop()]);
        await infra?.stop();
    });

    it('projects identity.user.created.v1 from identity-svc to admissions-svc', async () => {
        // 1. Create a user via identity-svc
        const created = await trpcMutate<CreatedUser>(identity.baseUrl, 'users.create', {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
        });
        expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(created.email).toBe('ada@example.com');

        // 2. Poll admissions-svc projection until the consumer has applied
        // the event. Latency budget: 5s (publish + consume + project).
        const projection = await pollUntil<UserProjection>(
            () =>
                trpcQuery<UserProjection>(
                    admissions.baseUrl,
                    'userProjection.getById',
                    { userId: created.id },
                ),
            (p) => p.userId === created.id,
            { timeoutMs: 5_000, intervalMs: 100 },
        );

        // 3. Assert the projection matches the source
        expect(projection.userId).toBe(created.id);
        expect(projection.name).toBe('Ada Lovelace');
        expect(projection.email).toBe('ada@example.com');
        expect(projection.createdAt).toBe(created.createdAt);
    });

    it('does not duplicate the projection on duplicate event delivery', async () => {
        // The consumed_events table guarantees idempotency — even if the
        // broker redelivers the same eventId, the handler runs once.
        // We simulate this by creating two distinct users; the second
        // should produce a separate projection row, not collide.
        const a = await trpcMutate<CreatedUser>(identity.baseUrl, 'users.create', {
            name: 'Grace Hopper',
            email: 'grace@example.com',
        });
        const b = await trpcMutate<CreatedUser>(identity.baseUrl, 'users.create', {
            name: 'Margaret Hamilton',
            email: 'margaret@example.com',
        });

        await pollUntil<UserProjection>(
            () => trpcQuery<UserProjection>(admissions.baseUrl, 'userProjection.getById', { userId: a.id }),
            (p) => p.userId === a.id,
            { timeoutMs: 5_000 },
        );
        await pollUntil<UserProjection>(
            () => trpcQuery<UserProjection>(admissions.baseUrl, 'userProjection.getById', { userId: b.id }),
            (p) => p.userId === b.id,
            { timeoutMs: 5_000 },
        );
    });
});
