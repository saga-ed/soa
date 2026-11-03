import { describe, expect, it, vi } from 'vitest';
import { createDatadogReader } from '../src/telemetry/datadog';
import { createPathRateReader, pathRateMeasurements } from '../src/telemetry/datadog-rates';
const scope = { environment: 'synthetic', deployment: 'slot-3', deploymentTag: 'deployment.identifier', machine: 'turing' };
const window = { from: 1800000000000, to: 1800000060000 };
const series = (count: unknown = 12) => ({ interval: 60, tag_set: ['env:synthetic', 'deployment.identifier:slot-3', 'synthetic.machine:turing', 'source.service:programs-api', 'peer.service:iam-api', 'http.method:get', 'http.route:/permissions'], pointlist: [[window.from, count]] });
const heartbeat = () => ({ ...series(1), interval: 10, pointlist: Array.from({ length: 6 }, (_, i) => [window.from + i * 10000, 1]) });
const result = (rows: unknown[]) => ({ status: 'ok', series: rows });
describe('unsampled completed-request rates', () => {
  it('divides an explicit count by its full bucket and preserves an observed zero', () => {
    const data = pathRateMeasurements(result([series(120)]), scope, window, result([heartbeat()]));
    expect(data.pathRates).toEqual([{ source: 'programs-api', target: 'iam-api', resource: 'GET /permissions', count: 120, rate: { at: window.to, value: 2 } }]);
    expect(data.pathRateStatus).toBe('available');
    expect(pathRateMeasurements(result([series(0)]), scope, window, result([heartbeat()])).pathRates[0].rate.value).toBe(0);
  });
  it('rejects wrong scope, missing buckets, invalid data, unexpected rollups and duplicate endpoint series', () => {
    for (const invalid of [
      { ...series(), tag_set: series().tag_set.filter(t => !t.startsWith('synthetic.machine')) },
      { ...series(), tag_set: series().tag_set.map(t => t === 'deployment.identifier:slot-3' ? 'deployment.identifier:slot-4' : t) },
      { ...series(), pointlist: [[window.from - 60000, 100]] },
      { ...series(), interval: 120 }, series(null), series(NaN), series(-1),
    ]) expect(pathRateMeasurements(result([invalid]), scope, window, result([heartbeat()])).pathRates).toEqual([]);
    expect(pathRateMeasurements(result([series(), series()]), scope, window, result([heartbeat()])).pathRates).toEqual([]);
    expect(pathRateMeasurements(result([]), scope, window, result([heartbeat()])).pathRateStatus).toBe('unavailable');
    expect(pathRateMeasurements({ status: 'error' }, scope, window, result([heartbeat()])).pathRateStatus).toBe('unavailable');
    // Datadog count padding alone cannot establish idle coverage after exporter loss.
    expect(pathRateMeasurements(result([series(0)]), scope, window, result([])).pathRates).toEqual([]);
    expect(pathRateMeasurements(result([series(0)]), scope, window, result([{ ...heartbeat(), pointlist: heartbeat().pointlist.slice(1) }])).pathRates).toEqual([]);
    expect(pathRateMeasurements(result([series(0)]), scope, window, result([{ ...series(1), pointlist: [[window.from - 60000, 1]] }])).pathRates).toEqual([]);
  });
  it('coalesces refreshes, leaves a minute for ingestion and never renews cached evidence timestamps', async () => {
    let clock = window.to + 60000;
    const query = vi.fn(async (p: Record<string,string>) => result([p.query.includes('metrics.active') ? heartbeat() : series()]));
    const read = createPathRateReader(scope, query, () => 'ready', () => clock);
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b); expect(query).toHaveBeenCalledTimes(2);
    expect(a.pathRateWindow).toEqual(window);
    const q = query.mock.calls[0] as unknown as [Record<string,string>];
    expect(q[0].query).toContain('env:synthetic,source.service:programs-api,peer.service:iam-api,deployment.identifier:slot-3,synthetic.machine:turing');
    expect(q[0].query).toContain('.as_count().rollup(sum,60)');
    clock += 20000; expect((await read()).pathRateObservedAt).toBe(a.pathRateObservedAt);
    clock += 10001; await read(); expect(query).toHaveBeenCalledTimes(4);
  });
  it('keeps successful request counters visible when all slower Datadog sources fail', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const q = new URL(String(input)).searchParams.get('query') ?? '';
      if (q.includes('saga.http.client.')) return new Response(JSON.stringify(result([q.includes('metrics.active') ? heartbeat() : series(120)])));
      return new Response('', { status: 403 });
    });
    const snapshot = await createDatadogReader({ DD_API_KEY: 'secret', DD_APP_KEY: 'secret', VISHNU_SLOT: '3', VISHNU_DATADOG_MACHINE: 'turing' }, fetcher as typeof fetch, () => window.to + 60000)();
    expect(snapshot.status).toBe('partial');
    expect(snapshot.pathRateStatus).toBe('available');
    expect(snapshot.pathRates?.[0].rate.value).toBe(2);
    expect(snapshot.pathEndpointStatus).toBe('unavailable');
  });
  it('does not query invalid or missing credentials and isolates metric failure', async () => {
    const query = vi.fn(async () => { throw new Error('denied'); });
    for (const state of ['unavailable', 'unconfigured'] as const) expect((await createPathRateReader(scope, query, () => state)()).pathRateStatus).toBe(state);
    expect(query).not.toHaveBeenCalled();
    expect((await createPathRateReader(scope, query, () => 'ready')()).pathRateStatus).toBe('unavailable');
  });
});
