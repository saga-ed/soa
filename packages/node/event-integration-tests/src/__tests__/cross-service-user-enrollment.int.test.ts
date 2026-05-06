import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(here, '../../../../..');
const CATALOG_SVC = resolve(REPO_ROOT, 'apps/catalog-svc');

interface CreatedUser {
    id: string;
    name: string;
    email: string;
    createdAt: string;
}
interface CreatedGroup {
    id: string;
    name: string;
    parentGroupId: string | null;
    createdAt: string;
}
interface CreatedProgram {
    id: string;
    name: string;
    schoolGroupId: string;
    createdAt: string;
}
interface CreatedPeriod {
    id: string;
    programId: string;
    name: string;
    sectionGroupId: string;
    createdAt: string;
}
interface AttendanceRow {
    id: string;
    userId: string;
    programId: string;
    periodId: string;
    date: string;
    status: string;
    recordedAt: string;
    recordedByUserId: string;
}

describe('cross-service user enrollment (Phase 2 full triplet)', () => {
    let infra: InfraHandle;
    let identity: SpawnedService;
    let catalog: SpawnedService;
    let admissions: SpawnedService;

    beforeAll(async () => {
        infra = await startInfra();

        const identityDbUrl = await infra.createDatabase('identity_test');
        const catalogDbUrl = await infra.createDatabase('catalog_test');
        const admissionsDbUrl = await infra.createDatabase('admissions_test');

        migrate(IDENTITY_SVC, identityDbUrl);
        migrate(CATALOG_SVC, catalogDbUrl);
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
        catalog = spawnService({
            serviceDir: CATALOG_SVC,
            port: 4002,
            env: {
                NODE_ENV: 'test',
                LOG_LEVEL: 'warn',
                DATABASE_URL: catalogDbUrl,
                RABBITMQ_URL: infra.rabbitmqUrl,
                EVENTS_EXCHANGE: 'catalog.events',
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
                CATALOG_EVENTS_EXCHANGE: 'catalog.events',
                UPSTREAM_EVENTS_QUEUE: 'admissions-svc.upstream-events.test',
                EVENTS_EXCHANGE: 'admissions.events',
            },
        });

        await Promise.all([
            waitForReady(identity.baseUrl),
            waitForReady(catalog.baseUrl),
            waitForReady(admissions.baseUrl),
        ]);
    }, 120_000);

    afterAll(async () => {
        await Promise.allSettled([
            identity?.stop(),
            catalog?.stop(),
            admissions?.stop(),
        ]);
        await infra?.stop();
    });

    it('drives the full triplet flow with eventual-consistency UX', async () => {
        // 1. Create user
        const user = await trpcMutate<CreatedUser>(identity.baseUrl, 'users.create', {
            name: 'Ada Lovelace',
            email: 'ada@example.com',
        });

        // 2. Create school group + add user
        const schoolGroup = await trpcMutate<CreatedGroup>(
            identity.baseUrl,
            'groups.create',
            { name: 'Saga School', parentGroupId: null },
        );
        await trpcMutate(identity.baseUrl, 'groups.addMember', {
            groupId: schoolGroup.id,
            userId: user.id,
        });

        // 3. Create program (references school group)
        const program = await trpcMutate<CreatedProgram>(
            catalog.baseUrl,
            'programs.create',
            { name: 'Algebra', schoolGroupId: schoolGroup.id },
        );

        // 4. Create section group + period
        const sectionGroup = await trpcMutate<CreatedGroup>(
            identity.baseUrl,
            'groups.create',
            { name: 'Section A', parentGroupId: schoolGroup.id },
        );
        const period = await trpcMutate<CreatedPeriod>(
            catalog.baseUrl,
            'periods.create',
            {
                programId: program.id,
                name: 'Period 1',
                sectionGroupId: sectionGroup.id,
            },
        );

        // 5. Eventual-consistency UX: poll /enrollment-readiness
        // Initially admissions-svc may not have processed the user/group/program
        // events yet — endpoint returns 202 + Retry-After. We poll until 200.
        const readinessRes = await pollUntil(
            () =>
                fetch(
                    `${admissions.baseUrl}/enrollment-readiness?userId=${user.id}&programId=${program.id}`,
                ),
            (r) => r.status === 200,
            { timeoutMs: 10_000, intervalMs: 100 },
        );
        const readinessBody = (await readinessRes.json()) as { ready: boolean };
        expect(readinessBody.ready).toBe(true);

        // 6. Record attendance
        const today = new Date().toISOString().slice(0, 10);
        const attendanceRow = await trpcMutate<AttendanceRow>(
            admissions.baseUrl,
            'attendance.record',
            {
                userId: user.id,
                programId: program.id,
                periodId: period.id,
                date: today,
                status: 'present',
                recordedByUserId: user.id,
            },
        );
        expect(attendanceRow.userId).toBe(user.id);
        expect(attendanceRow.status).toBe('present');

        // 7. Read attendance back
        const rows = await trpcQuery<AttendanceRow[]>(
            admissions.baseUrl,
            'attendance.listByPeriodAndDate',
            { periodId: period.id, date: today },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(attendanceRow.id);
    });
});
