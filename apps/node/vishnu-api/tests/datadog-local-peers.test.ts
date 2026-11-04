import { describe, expect, it, vi } from 'vitest';
import { createDatadogReader } from '../src/telemetry/datadog';

describe('synthetic client destination attribution', () => {
  it('uses observed loopback destination ports from the slot manifest, retaining measured counts and latency', async () => {
    const queries: any[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = init?.body ? JSON.parse(String(init.body)).data.attributes : undefined;
      if (request) queries.push(request);
      const ports = request?.group_by?.some((g: any) => g.facet === '@server.port');
      return new Response(JSON.stringify({
        data: ports ? [{ attributes: {
          by: { service: 'programs-api', '@server.port': '6010', '@http.method': 'GET', '@http.path_group': '/trpc/personas.getMyPermissions' },
          compute: { c0: 42, c1: 12_000_000 },
        } }] : [], meta: { status: 'done' }, series: [],
      }));
    });
    const read = createDatadogReader({ DD_API_KEY: 'test', DD_APP_KEY: 'test', VISHNU_DATADOG_ENV: 'synthetic', VISHNU_DATADOG_MACHINE: 'turing', VISHNU_SLOT: '3' }, fetcher as typeof fetch, () => 1800000000000, { '6010': 'iam-api' });
    const result = await read();
    expect(result.pathEndpoints).toEqual([{ source: 'programs-api', target: 'iam-api', resource: 'GET /trpc/personas.getMyPermissions', observedSpans: 42, p95Ms: 12 }]);
    expect(result.connections).toEqual([{ source: 'programs-api', target: 'iam-api', observedSpans: 42, p95Ms: 12 }]);
    for (const q of queries.filter(q => q.filter?.query.includes('@span.kind:client'))) {
      expect(q.filter.query).toContain('@synthetic.machine:turing');
      expect(q.filter.query).toContain('@deployment.identifier:slot-3');
      expect(q.filter.query).toContain('@http.url_details.host:(localhost OR 127.0.0.1)');
      expect(q.filter.query).toContain('@server.port:(6010)');
    }
  });

  it('never enables port attribution for a hosted environment', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return new Response(JSON.stringify({ data: [], meta: { status: 'done' }, series: [] }));
    });
    await createDatadogReader({ DD_API_KEY: 'test', DD_APP_KEY: 'test', VISHNU_DATADOG_ENV: 'dev', VISHNU_DATADOG_MACHINE: 'turing' }, fetcher as typeof fetch, Date.now, { '6010': 'iam-api' })();
    expect(bodies.join(' ')).not.toContain('@server.port');
    expect(bodies.join(' ')).toContain('@peer.service');
  });
});
