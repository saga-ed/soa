import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Chart, ChartSet, resolveWindow } from '../src/charts/schema';
import { createChartReader } from '../src/charts/reader';
import {
  alignResourcePairs,
  histogram,
  type ChartSpec,
} from '../../../web/vishnu/src/lib/graph/charts';
const now = Date.parse('2026-11-05T12:00:00Z');
const spec: ChartSpec = {
  id: randomUUID(),
  title: 'IAM history',
  system: 'iam-api',
  kind: 'line',
  metric: 'latency',
  statistics: ['avg', 'max'],
  time: { mode: 'rolling', minutes: 30 },
  group: 'service',
  population: 'observations',
};
const env = {
  DD_API_KEY: 'test',
  DD_APP_KEY: 'test',
  VISHNU_DATADOG_ENV: 'synthetic',
  VISHNU_DATADOG_DEPLOYMENT: 'slot-3',
  VISHNU_DATADOG_MACHINE: 'turing',
};
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
describe('declarative chart boundary', () => {
  it('rejects executable definitions, scope/query injection, incompatible types and excessive windows', () => {
    for (const input of [
      { ...spec, code: 'fetch(...)' },
      { ...spec, scope: 'prod' },
      { ...spec, system: 'iam-api OR *' },
      { ...spec, kind: 'scatter' },
      { ...spec, time: { mode: 'rolling', minutes: 50000 } },
      { ...spec, metric: 'cpu' },
      { ...spec, group: 'instance' },
    ])
      expect(Chart.safeParse(input).success).toBe(false);
    expect(
      ChartSet.safeParse({ version: 1, charts: Array(9).fill(spec), meshCollapsed: true }).success
    ).toBe(false);
    expect(() =>
      resolveWindow(
        { mode: 'fixed', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
        now
      )
    ).toThrow();
    expect(() =>
      resolveWindow(
        { mode: 'fixed', from: '2026-11-05T11:00:00Z', to: '2026-11-05T13:00:00Z' },
        now
      )
    ).toThrow();
  });
  it('advances rolling windows while preserving exact fixed dates', () => {
    expect(resolveWindow(spec.time, now + 3_600_000).to - resolveWindow(spec.time, now).to).toBe(
      3_600_000
    );
    const time = {
      mode: 'fixed' as const,
      from: '2026-11-05T10:00:00Z',
      to: '2026-11-05T11:00:00Z',
    };
    expect(resolveWindow(time, now)).toEqual(resolveWindow(time, now + 3_600_000));
  });
});
describe('scoped Datadog history', () => {
  it('uses server scope, converts nanoseconds, coalesces requests and keeps missing observations unknown', async () => {
    const fetcher = vi.fn(async () =>
      json({
        data: [
          {
            attributes: {
              compute: {
                c0: [
                  { time: '2026-11-05T11:30:00Z', value: 2e6 },
                  { time: '2026-11-05T11:31:00Z', value: null },
                ],
                c1: [{ time: '2026-11-05T11:30:00Z', value: 5e6 }],
              },
            },
          },
        ],
      })
    );
    const reader = createChartReader(env, fetcher, () => now);
    const [a, b] = await Promise.all([
      reader.read(spec),
      reader.read({ ...spec, id: randomUUID(), title: 'Another' }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.status).toBe('ready');
    expect(a.series[0].points[0][1]).toBe(2);
    expect(a.series[0].points[1][1]).toBe(null);
    const call = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.data.attributes.filter.query).toContain(
      'env:synthetic @deployment.identifier:slot-3 @synthetic.machine:turing service:iam-api'
    );
    expect(a.message).toContain('sampled');
    expect(a.link).toContain('slot-3');
  });
  it('constructs raw request distributions from histogram aggregates, never from averages', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ attributes: { compute: { c0: 3, c1: 20e6 } } }] }))
      .mockResolvedValueOnce(
        json({
          data: [
            { attributes: { by: { '@duration': 0 }, compute: { c0: 2 } } },
            { attributes: { by: { '@duration': 19000019 }, compute: { c0: 1 } } },
          ],
        })
      );
    const result = await createChartReader(env, fetcher, () => now).read({
      ...spec,
      kind: 'histogram',
    });
    expect(result.status).toBe('ready');
    expect(result.bins?.[0].buckets.reduce((n, b) => n + b.count, 0)).toBe(3);
    const body = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(body.data.attributes.compute).toEqual([{ aggregation: 'count', type: 'total' }]);
    expect(body.data.attributes.group_by[0].histogram.max).toBeGreaterThan(20e6);
  });
  it('labels histograms of interval statistics and preserves their count', async () => {
    const fetcher = vi.fn(async () =>
      json({
        data: [
          {
            attributes: {
              compute: {
                c0: [
                  { time: '2026-11-05T11:30:00Z', value: 2e6 },
                  { time: '2026-11-05T11:31:00Z', value: 4e6 },
                ],
                c1: [],
              },
            },
          },
        ],
      })
    );
    const result = await createChartReader(env, fetcher, () => now).read({
      ...spec,
      kind: 'histogram',
      population: 'rollups',
    });
    expect(result.bins?.[0].buckets.reduce((n, b) => n + b.count, 0)).toBe(2);
    expect(result.message).toContain('not individual requests');
  });
  it('does not fabricate native process CPU, or silently broaden a missing synthetic scope', async () => {
    const fetcher = vi.fn();
    const result = await createChartReader(env, fetcher, () => now).read({
      ...spec,
      kind: 'scatter',
      metric: 'cpu_memory',
      statistics: ['avg'],
    });
    expect(result.status).toBe('empty');
    expect(result.message).toContain('not substituted');
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await createChartReader(
          { ...env, VISHNU_DATADOG_MACHINE: undefined },
          fetcher,
          () => now
        ).read(spec)
      ).status
    ).toBe('unavailable');
  });
  it('bounds rate-limit retries and never returns stale data as fresh', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 429 }));
    const reader = createChartReader(env, fetcher, () => now);
    expect((await reader.read(spec)).status).toBe('unavailable');
    await reader.read({ ...spec, time: { mode: 'rolling', minutes: 60 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('revalidates resource scope and joins only the same replica and timestamp', async () => {
    const points = [[now - 60000, 1e9]],
      tags = [
        'env:dev',
        'ecs_container_name:iam-api',
        'task_family:soa-iam-api-blue',
        'container_id:a',
      ];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          series: [
            { tag_set: tags, pointlist: points },
            { tag_set: tags.map(t => (t === 'env:dev' ? 'env:prod' : t)), pointlist: points },
          ],
        })
      )
      .mockResolvedValueOnce(
        json({
          series: [
            {
              tag_set: tags,
              pointlist: [
                [now - 60000, 1048576],
                [now - 120000, 2097152],
              ],
            },
          ],
        })
      );
    const result = await createChartReader(
      {
        ...env,
        VISHNU_DATADOG_ENV: 'dev',
        VISHNU_DATADOG_MACHINE: undefined,
        VISHNU_DATADOG_DEPLOYMENT: 'blue',
      },
      fetcher,
      () => now
    ).read({ ...spec, kind: 'scatter', metric: 'cpu_memory', statistics: ['avg'] });
    expect(result.pairs).toEqual([
      { instance: 'soa-iam-api-blue/a', time: now - 60000, cpu: 1, memory: 1 },
    ]);
    expect(result.series).toHaveLength(2);
  });
});
describe('chart data transformations', () => {
  it('never pairs different replicas or fills missing values', () => {
    expect(
      alignResourcePairs([
        {
          name: 'cpu',
          unit: 'cores',
          instance: 'a',
          points: [
            [1, 1],
            [2, null],
          ],
        },
        { name: 'mem', unit: 'MiB', instance: 'b', points: [[1, 4]] },
      ])
    ).toEqual([]);
    expect(histogram([0, 0, 1, 2, NaN]).reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(histogram([])).toEqual([]);
  });
});
