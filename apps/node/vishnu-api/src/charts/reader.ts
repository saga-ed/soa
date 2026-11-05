import type {
  ChartSpec,
  ChartResult,
  ChartSeries,
} from '../../../../web/vishnu/src/lib/graph/charts';
import { alignResourcePairs, histogram } from '../../../../web/vishnu/src/lib/graph/charts';
import { Chart, resolveWindow } from './schema';
type Env = Record<string, string | undefined>;
const safe = /^[a-zA-Z0-9_.-]+$/;
const sites = new Set([
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
]);
// No query strings, hosts, credentials, or scope overrides come from a chart definition.
export function createChartReader(env: Env = process.env, fetcher = fetch, now = Date.now) {
  const scope = {
    environment: env.VISHNU_DATADOG_ENV ?? 'synthetic',
    deployment:
      env.VISHNU_DATADOG_SCOPE === 'environment'
        ? 'all'
        : (env.VISHNU_DATADOG_DEPLOYMENT ?? `slot-${env.VISHNU_SLOT ?? '0'}`),
    ...(env.VISHNU_DATADOG_MACHINE ? { machine: env.VISHNU_DATADOG_MACHINE } : {}),
  };
  const site = env.DD_SITE ?? 'datadoghq.com',
    deploymentTag = env.VISHNU_DATADOG_DEPLOYMENT_TAG ?? 'deployment.identifier';
  const cache = new Map<string, { at: number; value: ChartResult }>();
  const pending = new Map<string, Promise<ChartResult>>();
  let requests: number[] = [],
    retryAt = 0;
  async function request(
    path: string,
    query?: string,
    payload?: unknown,
    window?: { from: number; to: number }
  ): Promise<any> {
    requests = requests.filter(at => at > now() - 3_600_000);
    // Leave shared account capacity for the existing mesh reader. No automatic retries.
    if (requests.length >= 100 || retryAt > now())
      throw new Error('Historical query capacity reached.');
    requests.push(now());
    const url = new URL(path, `https://api.${site}`);
    if (query && window)
      url.search = new URLSearchParams({
        query,
        from: String(Math.floor(window.from / 1000)),
        to: String(Math.floor(window.to / 1000)),
      }).toString();
    const response = await fetcher(url, {
      ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}),
      headers: {
        'DD-API-KEY': env.DD_API_KEY!,
        'DD-APPLICATION-KEY': env.DD_APP_KEY!,
        'Content-Type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 429)
      retryAt =
        now() +
        Math.min(
          3_600_000,
          Math.max(60_000, Number(response.headers.get('x-ratelimit-reset')) * 1000 || 60_000)
        );
    if (!response.ok) throw new Error('Historical query unavailable.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing historical response.');
    let text = '',
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Historical response exceeds limit.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(text + decoder.decode());
  }
  async function collect(spec: ChartSpec): Promise<ChartResult> {
    const window = resolveWindow(spec.time, now());
    const intervalSeconds = Math.max(
      60,
      Math.ceil((window.to - window.from) / 1000 / 180 / 60) * 60
    );
    const spanQuery = `env:${scope.environment}${scope.deployment === 'all' ? '' : ` @${deploymentTag}:${scope.deployment}`}${scope.machine ? ` @synthetic.machine:${scope.machine}` : ''} service:${spec.system} @span.kind:server -@http.path_group:*/health*`;
    const link = new URL('/apm/traces', `https://app.${sites.has(site) ? site : 'datadoghq.com'}`);
    link.search = new URLSearchParams({
      query: spanQuery,
      start: String(window.from),
      end: String(window.to),
      paused: 'true',
    }).toString();
    const base: ChartResult = {
      status: 'empty',
      source: 'datadog',
      scope,
      window,
      observedAt: new Date(now()).toISOString(),
      intervalSeconds,
      message:
        'No observations in this scope and time window. Retention and collection coverage may be incomplete.',
      link: spec.metric === 'latency' ? link.href : '',
      series: [],
    };
    if (
      !sites.has(site) ||
      !Object.values(scope).every(v => safe.test(v)) ||
      !safe.test(deploymentTag) ||
      (scope.environment === 'synthetic' && (!scope.machine || scope.deployment === 'all'))
    )
      return {
        ...base,
        status: 'unavailable',
        message: 'Historical scope is not configured safely.',
      };
    if (!env.DD_API_KEY || !env.DD_APP_KEY)
      return {
        ...base,
        status: 'unconfigured',
        message: 'Datadog historical credentials are not configured.',
      };
    if (spec.metric !== 'latency' && (scope.environment === 'synthetic' || scope.machine))
      return {
        ...base,
        message:
          'No per-process resource history is collected for native synthetic services. Host usage is not substituted.',
      };
    try {
      if (spec.metric === 'latency') {
        const aggregate = async (compute: unknown[], group_by: unknown[] = []) => {
          const data = await request('/api/v2/spans/analytics/aggregate', undefined, {
            data: {
              type: 'aggregate_request',
              attributes: {
                filter: {
                  from: new Date(window.from).toISOString(),
                  to: new Date(window.to).toISOString(),
                  query: spanQuery,
                },
                compute,
                group_by,
              },
            },
          });
          if (!Array.isArray(data.data) || data.meta?.status === 'timeout')
            throw new Error('Incomplete span response.');
          return data.data as {
            attributes: { by?: Record<string, unknown>; compute: Record<string, unknown> };
          }[];
        };
        if (spec.kind === 'histogram' && spec.population === 'observations') {
          const summary = await aggregate([
            { aggregation: 'count', type: 'total' },
            { aggregation: 'max', metric: '@duration', type: 'total' },
          ]);
          const count = Number(summary[0]?.attributes.compute.c0 ?? 0),
            max = Number(summary[0]?.attributes.compute.c1 ?? 0);
          if (!count) return base;
          if (!Number.isFinite(max) || max < 0) throw new Error('Invalid duration.');
          const width = Math.max(1, Math.ceil((max + 1) / 20));
          const buckets = await aggregate(
            [{ aggregation: 'count', type: 'total' }],
            [
              {
                facet: '@duration',
                limit: 20,
                histogram: { min: 0, max: width * 20, interval: width },
              },
            ]
          );
          const bins = Array.from({ length: 20 }, (_, i) => ({
            from: (i * width) / 1e6,
            to: ((i + 1) * width) / 1e6,
            count: 0,
          }));
          for (const b of buckets) {
            const lower = Number(b.attributes.by?.['@duration']);
            const value = Number(b.attributes.compute.c0);
            if (!Number.isFinite(lower) || !Number.isFinite(value))
              throw new Error('Invalid histogram.');
            const i = Math.floor(lower / width);
            if (i >= 0 && i < bins.length) bins[i].count += value;
          }
          const included = bins.reduce((n, b) => n + b.count, 0);
          return {
            ...base,
            status: included ? 'ready' : 'empty',
            bins: [{ name: 'Retained request duration', unit: 'ms', buckets: bins }],
            message: `Distribution of ${included} retained server spans (sampled, not all requests). Summary count: ${count}; counts can change while spans arrive. Availability depends on Datadog indexing and retention.`,
          };
        }
        const buckets = await aggregate(
          spec.statistics.map(stat => ({
            aggregation: stat === 'p95' ? 'pc95' : stat,
            metric: '@duration',
            type: 'timeseries',
            interval: `${intervalSeconds}s`,
          }))
        );
        base.series = spec.statistics.map((stat, i) => ({
          name: `${stat} retained latency`,
          unit: 'ms',
          points: (
            (buckets[0]?.attributes.compute[`c${i}`] ?? []) as {
              time: string;
              value: number | null;
            }[]
          )
            .map(
              p =>
                [Date.parse(p.time), p.value === null ? null : p.value / 1e6] as [
                  number,
                  number | null,
                ]
            )
            .filter(
              p =>
                Number.isFinite(p[0]) &&
                p[0] >= window.from &&
                p[0] <= window.to &&
                (p[1] === null || Number.isFinite(p[1]))
            ),
        }));
        base.message =
          'Retained server spans only (sampled); not an all-request latency metric. Missing buckets are unknown. Historical coverage depends on Datadog retention.';
      } else {
        const metrics = spec.metric === 'cpu_memory' ? ['cpu', 'memory'] : [spec.metric];
        for (const metric of metrics) {
          const filter = `env:${scope.environment},ecs_container_name:${spec.system}${scope.deployment === 'all' ? '' : `,task_family:*-${scope.deployment}`}`;
          const query = `avg:container.${metric === 'cpu' ? 'cpu.usage' : 'memory.working_set'}{${filter}} by {env,ecs_container_name,task_family,container_id}.rollup(avg,${intervalSeconds})`;
          const data = await request('/api/v1/query', query, undefined, window);
          if (!Array.isArray(data.series)) throw new Error('Invalid metric response.');
          if (data.series.length > 20)
            throw new Error('Too many replicas. Narrow the time window.');
          for (const series of data.series) {
            const tags = Object.fromEntries(
              (series.tag_set ?? []).map((s: string) => {
                const i = s.indexOf(':');
                return [s.slice(0, i), s.slice(i + 1)];
              })
            );
            if (
              tags.env !== scope.environment ||
              tags.ecs_container_name !== spec.system ||
              !tags.container_id ||
              !tags.task_family ||
              (scope.deployment !== 'all' && !tags.task_family.endsWith(`-${scope.deployment}`))
            )
              continue;
            const instance = `${tags.task_family}/${tags.container_id}`;
            const points: ChartSeries['points'] = (series.pointlist ?? [])
              .filter(
                (p: unknown[]) =>
                  Array.isArray(p) &&
                  typeof p[0] === 'number' &&
                  p[0] >= window.from &&
                  p[0] <= window.to &&
                  (p[1] === null ||
                    (typeof p[1] === 'number' && Number.isFinite(p[1]) && p[1] >= 0))
              )
              .map(([t, v]: [number, number | null]) => [
                t,
                v === null ? null : v / (metric === 'cpu' ? 1e9 : 1048576),
              ]);
            base.series.push({
              name: `${metric} · ${instance}`,
              instance,
              unit: metric === 'cpu' ? 'cores' : 'MiB',
              points,
            });
          }
        }
        if (spec.group === 'service' && spec.kind !== 'scatter') {
          base.series = ['cores', 'MiB'].flatMap(unit => {
            const matching = base.series.filter(s => s.unit === unit);
            if (!matching.length) return [];
            const points = new Map<number, number[]>();
            for (const s of matching)
              for (const [t, v] of s.points)
                if (v !== null) points.set(t, [...(points.get(t) ?? []), v]);
            return [
              {
                name: `Mean reporting replica · ${unit}`,
                unit,
                points: [...points]
                  .sort((a, b) => a[0] - b[0])
                  .map(
                    ([t, v]) => [t, v.reduce((a, b) => a + b, 0) / v.length] as [number, number]
                  ),
              },
            ];
          });
        }
        base.message = `Interval averages per reporting container; service grouping is the mean of reporting replicas, not host usage or total capacity. Gaps remain unknown. ${scope.deployment === 'all' ? 'Environment-wide: includes all task families.' : ''}`;
      }
      if (spec.kind === 'line') {
        // Datadog omits empty span buckets. Break the line rather than bridge collection gaps.
        for (const series of base.series) {
          const points = [...series.points].sort((a, b) => a[0] - b[0]);
          series.points = points.flatMap((p, i) =>
            i > 0 && p[0] - points[i - 1][0] > intervalSeconds * 1500
              ? [[points[i - 1][0] + intervalSeconds * 1000, null] as [number, null], p]
              : [p]
          );
        }
      }
      if (spec.kind === 'histogram') {
        base.bins = base.series.map(s => ({
          name: s.name,
          unit: s.unit,
          buckets: histogram(s.points.flatMap(([, v]) => (v === null ? [] : [v]))),
        }));
        base.message += ` Histogram counts ${intervalSeconds}-second aggregate buckets, not individual requests.`;
      }
      if (spec.kind === 'scatter') {
        base.pairs = alignResourcePairs(base.series);
        base.message +=
          ' CPU and memory are paired at the same time for the same replica. Correlation is not causation.';
      }
      const present =
        spec.kind === 'scatter'
          ? base.pairs?.length
          : base.series.some(s => s.points.some(p => p[1] !== null));
      return { ...base, status: present ? 'ready' : 'empty' };
    } catch {
      return {
        ...base,
        status: 'unavailable',
        series: [],
        message:
          'Datadog history is unavailable or exceeds the query budget. Try a shorter window or retry later. Saved definitions remain available.',
      };
    }
  }
  return {
    scope,
    async read(input: ChartSpec) {
      const spec = Chart.parse(input);
      resolveWindow(spec.time, now());
      const key = JSON.stringify({ ...spec, id: undefined, title: undefined });
      const hit = cache.get(key);
      if (hit && now() - hit.at < 180_000) return hit.value;
      if (pending.has(key)) return pending.get(key)!;
      if (pending.size >= 4)
        throw new Error('Four historical queries are already running. Retry shortly.');
      const job = collect(spec)
        .then(value => {
          if (cache.size >= 64) cache.delete(cache.keys().next().value!);
          cache.set(key, { at: now(), value });
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, job);
      return job;
    },
  };
}
