import { describe, expect, it, vi } from 'vitest';
import { createResourceReader, parseResources } from '../src/telemetry/resources';
import { withResourceSystems } from '../src/telemetry/resource-mesh';
import { createFixture } from '../../../web/vishnu/src/lib/fixtures/mesh';
const now = Date.now();
const series = (value: number, id = 'replica-1', at = now, family = 'sds-ads-adm-api-blue') => ({
  tag_set: [
    'env:dev',
    'ecs_container_name:ads-adm-api',
    `container_id:${id}`,
    `task_family:${family}`,
  ],
  pointlist: [[at, value]] as [number, number][],
});
describe('per-container resource evidence', () => {
  it('adds resource-only workers without inventing calls, and rejects a different scope', () => {
    const mesh = {
      ...createFixture('overview'),
      scope: { environment: 'dev', deployment: 'all', deploymentTag: 'deployment.identifier' },
    };
    const row = parseResources([[series(500e6)]], now)[0];
    const data = {
      status: 'ready' as const,
      source: 'datadog' as const,
      scope: { environment: 'dev', deployment: 'all' },
      observedAt: new Date(now).toISOString(),
      window: { from: now - 300000, to: now },
      message: '',
      instances: [
        { ...row, system: 'session-analysis-worker' },
        { ...row, system: 'api' },
      ],
    };
    const enriched = withResourceSystems(mesh, data);
    expect(enriched.systems.some(s => s.id === 'session-analysis-worker')).toBe(true);
    expect(enriched.systems.some(s => s.id === 'api')).toBe(false);
    expect(enriched.relationships).toBe(mesh.relationships);
    expect(
      withResourceSystems(mesh, { ...data, scope: { environment: 'prod', deployment: 'all' } })
    ).toBe(mesh);
  });
  it('keeps replicas separate and converts nanocores/bytes without treating shares as limits', () => {
    const rows = parseResources(
      [
        [series(500e6), series(50e6, 'replica-2')],
        [series(1e9), series(0, 'replica-2')],
        [series(256e6)],
        [series(512e6)],
      ],
      now
    );
    expect(rows[0]).toMatchObject({
      cpuCores: 0.5,
      cpuPercent: 50,
      memoryPercent: 50,
      deployment: 'sds-ads-adm-api-blue',
    });
    expect(rows[1]).toMatchObject({ cpuCores: 0.05, cpuPercent: null, memoryBytes: null });
  });
  it('ignores stale samples and refuses to join measurements without instance identity', () => {
    expect(
      parseResources(
        [
          [
            series(1, 'old', now - 600_000),
            { tag_set: ['ecs_container_name:ads-adm-api'], pointlist: [[now, 42]] },
          ],
        ],
        now
      )
    ).toEqual([]);
  });
  it('never substitutes host usage for synthetic process metrics', async () => {
    const fetcher = vi.fn();
    const read = createResourceReader(
      {
        DD_API_KEY: 'test',
        DD_APP_KEY: 'test',
        VISHNU_DATADOG_ENV: 'synthetic',
        VISHNU_DATADOG_MACHINE: 'test',
      },
      fetcher,
      () => now
    );
    expect(await read()).toMatchObject({ status: 'empty', instances: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses a fixed query scope, rejects foreign series, and coalesces polling', async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({
            series: [
              series(10, 'blue'),
              series(10, 'other', now, 'sds-ads-adm-api-green'),
              {
                ...series(10, 'foreign'),
                tag_set: [
                  'env:prod',
                  'ecs_container_name:ads-adm-api',
                  'container_id:foreign',
                  'task_family:sds-ads-adm-api-blue',
                ],
              },
            ],
          })
        )
    );
    const read = createResourceReader(
      {
        DD_API_KEY: 'test',
        DD_APP_KEY: 'test',
        VISHNU_DATADOG_ENV: 'dev',
        VISHNU_DATADOG_DEPLOYMENT: 'blue',
      },
      fetcher as typeof fetch,
      () => now
    );
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(a.instances.map(x => x.instance)).toEqual(['blue']);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('task_family');
  });
});
