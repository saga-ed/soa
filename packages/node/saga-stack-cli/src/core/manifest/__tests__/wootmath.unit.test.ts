import { describe, expect, it } from 'vitest';
import { BUNDLES, closureOptsFor, closureOptsForIds, seedAddOnsFor } from '../../bundles.js';
import { computeClosure } from '../../closure.js';
import { defaultLaunchContext, launchPlan } from '../../launch-plan.js';
import { composeSeedPlan } from '../../seed/compose-seed-plan.js';
import { storePlan } from '../../snapshot/plan.js';
import { manifest } from '../index.js';
import type { RepoKey, ServiceId } from '../types.js';
import { migrateClosure } from '../../../runtime/migrate.js';

describe('Woot Math bundle', () => {
  const closure = () =>
    computeClosure(manifest, [...BUNDLES.wootmath.services], closureOptsFor(['wootmath']));
  const roots = Object.fromEntries(
    Object.values(manifest.services).map(s => [s.repo, `/dev/${s.repo.toLowerCase()}`])
  ) as Record<RepoKey, string>;

  it('requires exactly the student app, teacher dashboard, API, Postgres and RabbitMQ', () => {
    const c = closure();
    expect(c.services).toEqual(['ap-api', 'ap-dash', 'ap-student']);
    expect(c.databases).toEqual(['ap']);
    expect(c.mesh).toEqual(['postgres', 'rabbitmq']);
    expect(computeClosure(manifest, ['ap-dash'], closureOptsForIds(['ap-dash'])).services).toEqual([
      'ap-api',
      'ap-dash',
    ]);
    const base = computeClosure(manifest, Object.keys(manifest.services) as ServiceId[]);
    expect(base.services.some(id => id.startsWith('ap-'))).toBe(false);
  });

  it('isolates API, frontend proxy targets, origins, DB and MQ across slots', () => {
    const c = closure();
    const ctx = defaultLaunchContext({
      repoRoots: roots,
      vendorDir: '/vendor',
      meshOffset: 6000,
      portOverrides: { 'ap-api': 10310, 'ap-dash': 11180, 'ap-student': 11174 },
    });
    const [api, dash, student] = launchPlan(manifest, c.services, 'stack', ctx);
    expect(api.env).toMatchObject({
      AP_PORT: '10310',
      AP_AUTH_MODE: 'synthetic',
      AP_HOST: '127.0.0.1',
      DATABASE_URL: 'postgresql://ap:synthetic-ap-only@localhost:11432/ap',
      RABBITMQ_URL: 'amqp://rabbitmq_admin:password123@localhost:11672',
      AP_ORIGINS: 'http://127.0.0.1:11174,http://127.0.0.1:11180',
    });
    expect(dash.command).toBe('pnpm exec vite --host 127.0.0.1 --port 11180 --strictPort');
    expect(student.command).toBe('pnpm exec vite --host 127.0.0.1 --port 11174 --strictPort');
    for (const web of [dash, student]) expect(web.env.AP_API_TARGET).toBe('http://127.0.0.1:10310');
    expect(student.env.VITE_AP_API_ENABLED).toBe('true');
  });

  it('seeds only Founders for this bundle and respects restored data', () => {
    const selection = { profile: 'roster' as const, addOns: seedAddOnsFor(['wootmath']) };
    const active = new Set(closure().services);
    const plan = composeSeedPlan(selection, active, new Set());
    expect(plan.offline.map(s => s.id)).toEqual(['ap-founders']);
    expect(plan.online).toEqual([]);
    expect(plan.offline[0].command).toEqual(['pnpm', 'db:seed']);
    expect(composeSeedPlan(selection, active, new Set<ServiceId>(['ap-api'])).offline).toEqual([]);
    expect(composeSeedPlan({ profile: 'roster' }, active, new Set()).offline).toEqual([]);
  });

  it('runs the custom idempotent migrator without Prisma probes', async () => {
    const calls: unknown[] = [];
    const result = await migrateClosure({
      dbs: ['ap'],
      pgContainer: 'soa-s6-postgres-1',
      meshOffset: 6000,
      repoRoots: roots,
      probe: {
        async hasPrismaMigrations() {
          throw new Error('Must not probe Prisma');
        },
        async tableCount() {
          throw new Error('Must not probe Prisma');
        },
      } as never,
      runner: {
        async run(spec) {
          calls.push(spec);
          return { code: 0 };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        cwd: '/dev/wootmath/apps/node/ap-api',
        command: 'pnpm',
        args: ['db:migrate'],
        env: { DATABASE_URL: 'postgresql://ap:synthetic-ap-only@localhost:11432/ap' },
      }),
    ]);
  });

  it('snapshots AP only when selected, without requiring Prisma history', () => {
    const base = { fixtureId: 'test', profile: 'roster' };
    expect(
      storePlan(manifest, { ...base, withPlayback: true }).databases.map(d => d.db)
    ).not.toContain('ap');
    expect(storePlan(manifest, { ...base, withWootmath: true }).databases.map(d => d.db)).toContain(
      'ap'
    );
    expect(storePlan(manifest, { ...base, only: ['ap'] }).databases).toEqual([
      expect.objectContaining({ db: 'ap', captureSchemaRev: false }),
    ]);
  });
});
