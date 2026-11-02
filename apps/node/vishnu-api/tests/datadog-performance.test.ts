import { describe, expect, it, vi } from 'vitest';
import { createDatadogReader } from '../src/telemetry/datadog';
import { connectionMeasurements, endpointMeasurements, retainedEndpointMeasurements } from '../src/telemetry/datadog-performance';

const to = 1800000000000;
const from = to - 900000;
const fulfilled = (value: unknown) => ({ status: 'fulfilled' as const, value });
const rejected = { status: 'rejected' as const, reason: new Error('denied') };
const series = (tags: string[], value: number, at = to - 30000) => ({ tag_set: tags, pointlist: [[at, value]] });
const metric = (rows: unknown[]) => fulfilled({ status: 'ok', series: rows });

describe('endpoint and attributable connection measurements', () => {
  it('keeps endpoints distinct and source timestamps intact, never copies service totals', () => {
    const tags = ['service:programs-api', 'resource_name:GET /programs'];
    const result = endpointMeasurements([
      metric([series(tags, 0), series(['service:programs-api'], 999)]),
      metric([series(tags, 0.25), series(['service:programs-api', 'resource_name:GET /periods'], 1)]),
      rejected,
    ], from, to);
    expect(result.endpointStatus).toBe('partial');
    expect(result.endpoints).toEqual([
      { service: 'programs-api', resource: 'GET /programs', rate: { at: to - 30000, value: 0 }, p95Ms: { at: to - 30000, value: 250 }, errorRate: null },
      { service: 'programs-api', resource: 'GET /periods', rate: null, p95Ms: { at: to - 30000, value: 1000 }, errorRate: null },
    ]);
  });

  it('keeps old, nonfinite, future and missing measurements unknown, and bounds resource cardinality', () => {
    const rows = Array.from({ length: 201 }, (_, i) => series(['service:api', `resource_name:GET /${i}`], 1));
    const result = endpointMeasurements([metric(rows), metric([]), metric([])], from, to);
    expect(result.endpoints).toHaveLength(200);
    expect(result.endpointLimited).toBe(true);
    expect(result.endpointStatus).toBe('partial');
    for (const [at, value] of [[from - 1, 1], [to + 1, 1], [to, Infinity], [to, -1]]) {
      const invalid = endpointMeasurements([metric([series(['service:api', 'resource_name:GET /x'], value, at)]), metric([]), metric([])], from, to);
      expect(invalid.endpoints[0].rate).toBeNull();
    }
    expect(endpointMeasurements([rejected, rejected, rejected], from, to).endpointStatus).toBe('unavailable');
  });

  it('uses only explicit cross-service attribution and converts retained-span nanoseconds to ms', () => {
    const row = (source: string | undefined, target: string) => ({ attributes: { by: { service: source, '@peer.service': target }, compute: { c0: 12, c1: 250000000 } } });
    const result = connectionMeasurements(fulfilled({ data: [row('iam-api', 'programs-api'), row('iam-api', 'iam-api'), row(undefined, 'programs-api')], meta: { status: 'done' } }));
    expect(result.connections).toEqual([{ source: 'iam-api', target: 'programs-api', observedSpans: 12, p95Ms: 250 }]);
    expect(result.connectionStatus).toBe('partial');
    expect(connectionMeasurements(fulfilled({ data: [], meta: { status: 'done' } }))).toMatchObject({ connections: [], connectionStatus: 'available' });
    expect(connectionMeasurements(rejected).connectionStatus).toBe('unavailable');
    expect(connectionMeasurements(fulfilled({ data: [], meta: { status: 'timeout' } })).connectionStatus).toBe('partial');
  });

  it('uses exact deployment scope for resource metrics and indexed connection queries with a bounded budget', async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push({ url, init });
      const body = url.pathname === '/api/v1/query' ? { status: 'ok', series: [] }
        : url.pathname === '/api/v1/monitor' ? []
        : url.pathname === '/api/v1/service_dependencies' ? {}
        : { data: [], meta: { status: 'done' } };
      return new Response(JSON.stringify(body));
    });
    const read = createDatadogReader({ DD_API_KEY: 'secret', DD_APP_KEY: 'secret', VISHNU_SLOT: '3', VISHNU_DATADOG_ENV: 'dev', VISHNU_DATADOG_DEPLOYMENT: 'turing-slot-3' }, fetcher as typeof fetch, () => to);
    const result = await read(); await read();
    expect(calls).toHaveLength(13);
    expect(calls.filter(c => c.url.pathname === '/api/v1/query')).toHaveLength(6);
    for (const c of calls.filter(c => c.url.pathname === '/api/v1/query')) expect(c.url.searchParams.get('query')).toContain('env:dev,deployment.identifier:turing-slot-3');
    const connection = calls.find(c => c.url.pathname.includes('/spans/') && JSON.parse(String(c.init?.body)).data.attributes.group_by?.length === 2)!;
    expect(connection.init?.method).toBe('POST');
    const request = JSON.parse(String(connection.init?.body)).data.attributes;
    expect(request.filter.query).toBe('env:dev @deployment.identifier:turing-slot-3 @span.kind:client @peer.service:* -@http.path_group:*/health*');
    expect(request.group_by).toHaveLength(2);
    expect(request.group_by.every((g: {limit: number}) => g.limit === 20)).toBe(true);
    expect(result).toMatchObject({ status: 'connected', endpointStatus: 'available', connectionStatus: 'available' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});


describe('synthetic retained-span measurements', () => {
  it('requires machine scope and never queries global metrics for a slot', async () => {
    const env = { DD_API_KEY: 'secret', DD_APP_KEY: 'secret', VISHNU_SLOT: '3' };
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)).data.attributes;
      const by = query.group_by?.length === 1 ? { service: 'iam-api' } : { service: 'iam-api', '@http.method': 'GET', '@http.path_group': '/users' };
      return new Response(JSON.stringify({data: [{ attributes: { by, compute: { c0: 12, c1: 250000000 } } }], meta: { status: 'done' }}));
    });
    expect((await createDatadogReader(env, fetcher as typeof fetch, () => to)()).status).toBe('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
    const read = createDatadogReader({ ...env, VISHNU_DATADOG_MACHINE: 'turing' }, fetcher as typeof fetch, () => to);
    const data = await read(); await read();
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const [input, init] of fetcher.mock.calls) {
      expect(String(input)).toContain('/api/v2/spans/');
      const query = JSON.parse(String(init?.body)).data.attributes.filter.query;
      expect(query).toContain('env:synthetic @deployment.identifier:slot-3 @synthetic.machine:turing');
      expect(query).toContain('-@http.path_group:*/health*');
    }
    expect(data.scope.machine).toBe('turing');
    expect(data.measurementSource).toBe('retained-spans');
    expect(data.services[0]).toMatchObject({ observedSpans: 12, rate: null, errorRate: null, p95Ms: {value:250} });
    expect(data.endpoints?.[0]).toMatchObject({ observedSpans: 12, rate: null, errorRate: null, p95Ms: {value:250} });
  });

  it('does not turn an empty or failed retained-span response into zero traffic', () => {
    expect(retainedEndpointMeasurements(fulfilled({data: [], meta: {status:'done'}}), to)).toMatchObject({endpoints:[],endpointStatus:'available'});
    expect(retainedEndpointMeasurements(rejected, to)).toMatchObject({endpoints:[],endpointStatus:'unavailable'});
    expect(retainedEndpointMeasurements(fulfilled({data:[{attributes:{by:{service:'api'},compute:{c0:4}}}],meta:{status:'done'}}),to)).toMatchObject({endpoints:[],endpointStatus:'partial'});
  });
});


describe('hosted endpoint identity', () => {
  it('uses normalized retained paths when metric resources are coarse HTTP verbs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/query') return new Response(JSON.stringify({status:'ok',series:[series(['service:programs-api','resource_name:GET'],3)]}));
      if (url.pathname === '/api/v1/monitor') return new Response('[]');
      if (url.pathname === '/api/v1/service_dependencies') return new Response('{}');
      const q = JSON.parse(String(init?.body)).data.attributes.filter.query;
      return new Response(JSON.stringify({data:q.includes('@span.kind:server') ? [{attributes:{by:{service:'programs-api','@http.method':'GET','@http.path_group':'/trpc/programs.list'},compute:{c0:5,c1:20000000}}}] : [],meta:{status:'done'}}));
    });
    const data = await createDatadogReader({DD_API_KEY:'secret',DD_APP_KEY:'secret',VISHNU_DATADOG_ENV:'dev',VISHNU_DATADOG_SCOPE:'environment'},fetcher as typeof fetch,()=>to)();
    expect(data.measurementSource).toBe('apm-metrics');
    expect(data.endpointSource).toBe('retained-spans');
    expect(data.endpoints).toEqual([{service:'programs-api',resource:'GET /trpc/programs.list',observedSpans:5,rate:null,errorRate:null,p95Ms:{at:to,value:20}}]);
  });
});


describe('independent measurement availability', () => {
  const env = { DD_API_KEY: 'secret', DD_APP_KEY: 'secret', VISHNU_DATADOG_ENV: 'dev', VISHNU_DATADOG_SCOPE: 'environment' };
  const endpointBuckets = ['coarse-api', 'named-api'].map(service => ({attributes:{by:{service,'@http.method':'GET','@http.path_group':`/${service}/items`},compute:{c0:5,c1:20000000}}}));
  const spans = (init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)).data.attributes.filter.query;
    return new Response(JSON.stringify({data:query.includes('@span.kind:server') ? endpointBuckets : [{attributes:{by:{service:'coarse-api','@peer.service':'named-api'},compute:{c0:3,c1:12000000}}}],meta:{status:'done'}}));
  };

  it('uses a uniform retained source when a mixed fleet has both coarse and named metric resources', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/query') return new Response(JSON.stringify({status:'ok',series:[series(['service:coarse-api','resource_name:GET'],3),series(['service:named-api','resource_name:GET /items'],4)]}));
      if (url.pathname === '/api/v1/monitor') return new Response('[]');
      if (url.pathname === '/api/v1/service_dependencies') return new Response('{}');
      return spans(init);
    });
    const data = await createDatadogReader(env,fetcher as typeof fetch,()=>to)();
    expect(data.endpointSource).toBe('retained-spans');
    expect(data.endpoints?.map(e=>e.service)).toEqual(['coarse-api','named-api']);
    expect(data.endpoints?.every(e=>e.observedSpans===5 && e.rate===null)).toBe(true);
  });

  it('keeps successful endpoint and connection evidence usable when all legacy sources fail', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith('/api/v1/')) return new Response('',{status:403});
      return spans(init);
    });
    const data = await createDatadogReader(env,fetcher as typeof fetch,()=>to)();
    expect(data.status).toBe('partial');
    expect(data.services).toEqual([]);
    expect(data.endpointStatus).toBe('available');
    expect(data.endpoints).toHaveLength(2);
    expect(data.connectionStatus).toBe('available');
    expect(data.connections).toEqual([{source:'coarse-api',target:'named-api',observedSpans:3,p95Ms:12}]);
  });
});
