import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { startInfra } from '@saga-ed/soa-event-test-harness';
import { ChartViewStore } from '../../../node/vishnu-api/src/charts/store';
let infra: Awaited<ReturnType<typeof startInfra>>, pool: Pool, url: string;
const definition = {
  version: 1,
  meshCollapsed: true,
  charts: [
    {
      id: randomUUID(),
      title: 'Private IAM',
      system: 'iam-api',
      kind: 'line',
      metric: 'latency',
      statistics: ['avg', 'max'],
      time: { mode: 'rolling', minutes: 30 },
      group: 'service',
      population: 'observations',
    },
  ],
};
beforeAll(async () => {
  infra = await startInfra();
  url = await infra.createDatabase(`chart_views_${process.env.VITEST_POOL_ID ?? 'default'}`);
  pool = new Pool({ connectionString: url });
});
afterAll(async () => {
  await pool?.end();
  await infra?.stop();
});
describe('Postgres private chart views', () => {
  it('persists across connections, isolates identities and scopes, and detects concurrent edits', async () => {
    const store = new ChartViewStore(pool, 'dev/blue');
    const saved = await store.save('staff-a', { name: 'My charts', definition });
    expect(await store.list('staff-b')).toEqual([]);
    const otherScope = new ChartViewStore(pool, 'prod/green');
    expect(await otherScope.list('staff-a')).toEqual([]);
    await expect(
      store.save('staff-b', { name: 'Stolen', definition, revision: 1 }, saved.id)
    ).rejects.toThrow('unavailable');
    await expect(store.remove('staff-b', saved.id)).rejects.toThrow('unavailable');
    const freshPool = new Pool({ connectionString: url });
    try {
      expect(
        (await new ChartViewStore(freshPool, 'dev/blue').list('staff-a'))[0].definition
      ).toEqual(definition);
    } finally {
      await freshPool.end();
    }
    const changed = await store.save(
      'staff-a',
      { name: 'Renamed', definition, revision: 1 },
      saved.id
    );
    expect(changed.revision).toBe(2);
    await expect(
      store.save('staff-a', { name: 'Old edit', definition, revision: 1 }, saved.id)
    ).rejects.toThrow('changed');
    await store.remove('staff-a', saved.id);
    expect(await store.list('staff-a')).toEqual([]);
  });
  it('enforces the quota even for concurrent creates', async () => {
    const store = new ChartViewStore(pool, 'dev/blue');
    await store.init();
    await pool.query(
      `INSERT INTO vishnu_chart_view (id,owner,scope,name,definition) SELECT gen_random_uuid(),'quota','dev/blue','existing',$1 FROM generate_series(1,49)`,
      [JSON.stringify(definition)]
    );
    const results = await Promise.allSettled([
      store.save('quota', { name: 'A', definition }),
      store.save('quota', { name: 'B', definition }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.list('quota')).length).toBe(50);
  });
});
