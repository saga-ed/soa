import type { DatadogSnapshot, DatadogService, MetricPoint } from '../src/lib/graph/datadog';

type Env = Record<string, string | undefined>;
const sites: Record<string, string> = {
  'datadoghq.com': 'https://app.datadoghq.com',
  'datadoghq.eu': 'https://app.datadoghq.eu',
  'us3.datadoghq.com': 'https://us3.datadoghq.com',
  'us5.datadoghq.com': 'https://us5.datadoghq.com',
  'ap1.datadoghq.com': 'https://ap1.datadoghq.com',
  'ap2.datadoghq.com': 'https://ap2.datadoghq.com',
};
const safeTag = /^[a-zA-Z0-9_.:/-]+$/;
const numeric = (value: string | undefined, fallback: number) =>
  value && Number.isFinite(+value) && +value > 0 ? +value : fallback;

/** Fixed read-only endpoints, bounded time range, coalesced cache. Credentials never leave this module. */
export function createDatadogReader(
  env: Env = process.env,
  fetcher: typeof fetch = fetch,
  now = Date.now
) {
  const site = env.DD_SITE ?? 'datadoghq.com';
  const scope = {
    environment: env.VISHNU_DATADOG_ENV ?? 'synthetic',
    deployment: env.VISHNU_DATADOG_DEPLOYMENT ?? `slot-${env.VISHNU_SLOT ?? '0'}`,
    deploymentTag: env.VISHNU_DATADOG_DEPLOYMENT_TAG ?? 'deployment.identifier',
  };
  const prefix = env.VISHNU_DATADOG_METRIC_PREFIX ?? 'trace.http.server.request';
  const thresholds = {
    hotRate: numeric(env.VISHNU_DATADOG_HOT_RATE, 10),
    warningP95Ms: numeric(env.VISHNU_DATADOG_WARNING_P95_MS, 2500),
    criticalP95Ms: numeric(env.VISHNU_DATADOG_CRITICAL_P95_MS, 5000),
  };
  let cache: DatadogSnapshot | undefined;
  let cachedAt = 0;
  let pending: Promise<DatadogSnapshot> | undefined;
  let retryAt = 0;
  const request = async (path: string, params: Record<string, string>) => {
    const url = new URL(path, `https://api.${site}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetcher(url, {
      headers: {
        'DD-API-KEY': env.DD_API_KEY!,
        'DD-APPLICATION-KEY': env.DD_APP_KEY!,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 429)
        retryAt =
          now() +
          Math.min(
            3600000,
            Math.max(60000, Number(response.headers.get('x-ratelimit-reset')) * 1000 || 60000)
          );
      throw new Error('Datadog query unavailable');
    }
    const body = await response.text();
    if (body.length > 4_000_000) throw new Error('Response too large');
    return JSON.parse(body);
  };
  const collect = async (): Promise<DatadogSnapshot> => {
    const to = now();
    const from = to - 15 * 60000;
    const base: DatadogSnapshot = {
      version: 1,
      status: 'unconfigured',
      message: 'Datadog runtime credentials are not configured.',
      observedAt: new Date(to).toISOString(),
      serverNow: to,
      freshForMs: 180000,
      scope,
      appUrl: sites[site] ?? sites['datadoghq.com'],
      window: { from, to },
      thresholds,
      services: [],
      dependencies: [],
    };
    if (
      !sites[site] ||
      !Object.values(scope).every(v => safeTag.test(v)) ||
      !safeTag.test(prefix) ||
      thresholds.warningP95Ms >= thresholds.criticalP95Ms
    )
      return {
        ...base,
        status: 'unavailable',
        message: 'Invalid Datadog site, scope or thresholds.',
      };
    if (!env.DD_API_KEY || !env.DD_APP_KEY) return base;
    const tags = `env:${scope.environment},${scope.deploymentTag}:${scope.deployment}`;
    const metricQuery = (query: string) =>
      request('/api/v1/query', {
        from: String(Math.floor(from / 1000)),
        to: String(Math.floor(to / 1000)),
        query,
      });
    const results = await Promise.allSettled([
      metricQuery(`sum:${prefix}.hits{${tags}} by {service}.as_rate()`),
      metricQuery(`p95:${prefix}{${tags}} by {service}`),
      metricQuery(`sum:${prefix}.errors{${tags}} by {service}.as_rate()`),
      request('/api/v1/service_dependencies', {
        env: scope.environment,
        primary_tag: `${scope.deploymentTag}:${scope.deployment}`,
        start: String(Math.floor(from / 1000)),
        end: String(Math.floor(to / 1000)),
      }),
      request('/api/v1/monitor', {
        group_states: 'all',
        monitor_tags: 'scope:service-mesh',
        page_size: '100',
        page: '0',
      }),
    ]);
    const services = new Map<string, DatadogService>();
    const service = (name: string) => {
      if (!services.has(name))
        services.set(name, {
          service: name,
          rate: null,
          p95Ms: null,
          errorRate: null,
          previousP95Ms: null,
          monitors: [],
        });
      return services.get(name)!;
    };
    let failures = results.filter(r => r.status === 'rejected').length;
    for (const [i, field] of ['rate', 'p95Ms', 'errorRate'].entries()) {
      const result = results[i];
      if (result.status !== 'fulfilled') continue;
      if (result.value.status !== 'ok' || !Array.isArray(result.value.series)) {
        failures++;
        continue;
      }
      for (const series of result.value.series) {
        const name = (series.tag_set ?? String(series.scope ?? '').split(','))
          .find((t: string) => t.startsWith('service:'))
          ?.slice(8);
        if (!name || !safeTag.test(name) || !Array.isArray(series.pointlist)) continue;
        const points = series.pointlist
          .filter(
            (p: unknown[]) =>
              Array.isArray(p) &&
              typeof p[0] === 'number' &&
              typeof p[1] === 'number' &&
              Number.isFinite(p[1]) &&
              p[1] >= 0 &&
              p[0] >= from &&
              p[0] <= to
          )
          .sort((a: number[], b: number[]) => a[0] - b[0]);
        if (!points.length) continue;
        const latest = points.at(-1);
        const multiplier = field === 'p95Ms' ? 1000 : 1;
        const point: MetricPoint = { at: latest[0], value: latest[1] * multiplier };
        service(name)[field as 'rate' | 'p95Ms' | 'errorRate'] = point;
        if (field === 'p95Ms') {
          const previous = points.filter((p: number[]) => p[0] <= latest[0] - 300000).at(-1);
          service(name).previousP95Ms = previous ? previous[1] * multiplier : null;
        }
      }
    }
    const dep = results[3];
    if (dep.status === 'fulfilled') {
      if (
        !dep.value ||
        typeof dep.value !== 'object' ||
        Array.isArray(dep.value) ||
        dep.value.errors
      )
        failures++;
      else
        for (const [source, value] of Object.entries(dep.value)) {
          if (!safeTag.test(source) || !Array.isArray((value as { calls?: unknown }).calls))
            continue;
          for (const target of (value as { calls: unknown[] }).calls)
            if (typeof target === 'string' && safeTag.test(target))
              base.dependencies.push({ source, target });
        }
    }
    const monitorResult = results[4];
    if (monitorResult.status === 'fulfilled') {
      if (!Array.isArray(monitorResult.value)) failures++;
      else
        for (const monitor of monitorResult.value) {
          // Only explicitly scoped groups qualify. An environment-wide monitor must not color a slot.
          for (const [group, state] of Object.entries(monitor.state?.groups ?? {})) {
            const groupTags = group.split(',');
            if (
              !groupTags.includes(`env:${scope.environment}`) ||
              !groupTags.includes(`${scope.deploymentTag}:${scope.deployment}`)
            )
              continue;
            const name = groupTags.find(t => t.startsWith('service:'))?.slice(8);
            if (name && safeTag.test(name) && Number.isSafeInteger(monitor.id))
              service(name).monitors.push({
                id: monitor.id,
                name: String(monitor.name).slice(0, 200),
                status: String((state as { status?: string }).status ?? 'Unknown'),
                url: `${base.appUrl}/monitors/${monitor.id}`,
              });
          }
        }
    }
    return {
      ...base,
      services: [...services.values()],
      status: failures === 5 ? 'unavailable' : failures ? 'partial' : 'connected',
      message: failures
        ? 'Some Datadog queries are unavailable. Missing signals remain unknown.'
        : 'Datadog observations; metrics reflect the configured instrumentation and sampling.',
    };
  };
  return async () => {
    if (cache && (now() - cachedAt < 60000 || now() < retryAt))
      return { ...cache, serverNow: now() };
    pending ??= collect()
      .then(value => {
        cache = value;
        cachedAt = now();
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
    return { ...(await pending), serverNow: now() };
  };
}
