import { describe, it, expect, vi } from 'vitest';
import { createDatadogReader } from './datadog';
import { currentPoint, serviceSignal, matchesMesh, traceLink } from '../src/lib/graph/datadog';
import { createFixture } from '../src/lib/fixtures/mesh';
const time = 1800000000000;
const env = { DD_API_KEY: 'test-api-secret', DD_APP_KEY: 'test-app-secret', VISHNU_SLOT: '3' };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function backend() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/query') {
      const q = url.searchParams.get('query')!;
      return ok({
        status: 'ok',
        series: [
          {
            tag_set: ['service:programs-api'],
            pointlist: [
              [time - 360000, q.startsWith('p95') ? 1 : 0],
              [time - 30000, q.startsWith('p95') ? 3 : 0],
            ],
          },
        ],
      });
    }
    if (url.pathname === '/api/v1/monitor')
      return ok([
        {
          id: 1,
          name: 'wrong deployment',
          state: {
            groups: {
              'env:synthetic,deployment.identifier:slot-0,service:programs-api': {
                status: 'Alert',
              },
            },
          },
        },
        {
          id: 2,
          name: 'scoped warning',
          state: {
            groups: {
              'env:synthetic,deployment.identifier:slot-3,service:programs-api': { status: 'Warn' },
            },
          },
        },
      ]);
    return ok({ 'programs-api': { calls: ['scheduling-api'] } });
  });
}
describe('Datadog read adapter', () => {
  it('coalesces and caches scoped reads without disclosing credentials; converts seconds to ms', async () => {
    const fetcher = backend();
    let clock = time;
    const read = createDatadogReader(env, fetcher as typeof fetch, () => clock);
    const [a, b] = await Promise.all([read(), read()]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(a).toEqual(b);
    expect(a.services[0]).toMatchObject({
      rate: { value: 0 },
      p95Ms: { value: 3000 },
      previousP95Ms: 1000,
      monitors: [{ id: 2 }],
    });
    expect(a.dependencies).toEqual([{ source: 'programs-api', target: 'scheduling-api' }]);
    expect(JSON.stringify(a)).not.toContain('secret');
    for (const [input] of fetcher.mock.calls.slice(0, 3))
      expect(new URL(String(input)).searchParams.get('query')).toContain(
        'env:synthetic,deployment.identifier:slot-3'
      );
    clock += 30000;
    expect((await read()).serverNow).toBe(clock);
    expect(fetcher).toHaveBeenCalledTimes(5);
    clock += 31000;
    await read();
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
  it('does not call Datadog when credentials are missing or scope/site is unsafe', async () => {
    const fetcher = backend();
    expect((await createDatadogReader({}, fetcher as typeof fetch)()).status).toBe('unconfigured');
    for (const extra of [
      { DD_SITE: 'evil.example' },
      { VISHNU_DATADOG_ENV: 'dev} OR *' },
      { VISHNU_DATADOG_WARNING_P95_MS: '6000' },
    ])
      expect(
        (await createDatadogReader({ ...env, ...extra }, fetcher as typeof fetch)()).status
      ).toBe('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains unknown rather than zero for missing/error responses; handles partial failures', async () => {
    const fetcher = backend();
    const partial = (async (input: string | URL | Request) =>
      String(input).includes('query')
        ? ok({ status: 'error', error: 'secret' })
        : fetcher(input)) as typeof fetch;
    const data = await createDatadogReader(env, partial, () => time)();
    expect(data.status).toBe('partial');
    expect(data.services[0].rate).toBeNull();
    expect(data.services[0].p95Ms).toBeNull();
    expect(JSON.stringify(data)).not.toContain('secret');
    const denied = await createDatadogReader(
      env,
      vi.fn(async () => new Response('secret', { status: 403 })) as typeof fetch
    )();
    expect(denied.status).toBe('unavailable');
    expect(denied.services).toEqual([]);
  });
  it('backs off after rate limits and does not reset observation freshness on cache hits', async () => {
    let clock = time;
    const fetcher = vi.fn(
      async () => new Response('', { status: 429, headers: { 'x-ratelimit-reset': '300' } })
    );
    const read = createDatadogReader(env, fetcher as typeof fetch, () => clock);
    const a = await read();
    clock += 120000;
    const b = await read();
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(b.observedAt).toBe(a.observedAt);
    expect(b.serverNow).toBe(clock);
  });
  it('keeps slot scope, stale data, failures and true zero distinct; creates scoped safe links', async () => {
    const data = await createDatadogReader(env, backend() as typeof fetch, () => time)();
    expect(matchesMesh(data, { ...createFixture(), mode: 'live', slot: 3 })).toBe(true);
    expect(matchesMesh(data, { ...createFixture(), mode: 'live', slot: 0 })).toBe(false);
    expect(serviceSignal(data, 'programs-api', time)).toMatchObject({
      rate: 0,
      slow: true,
      risk: 'warning',
    });
    expect(serviceSignal(data, 'programs-api', time + 190000).p95Ms).toBeNull();
    expect(serviceSignal(data, 'programs-api', time, true).monitors).toEqual([]);
    expect(currentPoint(null, time, 180000)).toBeNull();
    const url = new URL(traceLink(data, 'a', 'b'));
    expect(url.origin).toBe('https://app.datadoghq.com');
    expect(url.searchParams.get('query')).toBe(
      'env:"synthetic" @deployment.identifier:"slot-3" service:"b" @span.parent.service:"a"'
    );
  });
});
