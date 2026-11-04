import type {
  ResourceInstance,
  ResourceSnapshot,
} from '../../../../web/vishnu/src/lib/graph/assistant';

type Env = Record<string, string | undefined>;
const sites = new Set([
  'datadoghq.com',
  'datadoghq.eu',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
]);
const safe = /^[a-zA-Z0-9_.-]+$/;
const metrics = [
  'container.cpu.usage',
  'container.cpu.limit',
  'container.memory.working_set',
  'container.memory.limit',
] as const;
type Series = { tag_set?: string[]; pointlist?: [number, number | null][] };

/** Keep each replica separate, with the task family retained as its deployment identity. */
export function parseResources(results: Series[][], now: number): ResourceInstance[] {
  const instances = new Map<string, ResourceInstance>();
  for (let metric = 0; metric < results.length; metric++)
    for (const series of results[metric] ?? []) {
      const tags = Object.fromEntries(
        (series.tag_set ?? []).map(t => {
          const at = t.indexOf(':');
          return [t.slice(0, at), t.slice(at + 1)];
        })
      );
      const system = tags.ecs_container_name,
        instance = tags.container_id,
        deployment = tags.task_family;
      if (!system || !instance || !deployment || !safe.test(system)) continue;
      const points = (series.pointlist ?? []).filter(
        (p): p is [number, number] =>
          Number.isFinite(p[1]) && p[1]! >= 0 && p[0] <= now + 60_000 && p[0] >= now - 5 * 60_000
      );
      if (!points.length) continue;
      const observed = Math.max(...points.map(p => p[0]));
      if (now - observed > 180_000) continue;
      const value = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const key = JSON.stringify([system, instance, deployment]);
      const row = instances.get(key) ?? {
        system,
        instance,
        deployment,
        cpuCores: null,
        cpuLimitCores: null,
        cpuPercent: null,
        memoryBytes: null,
        memoryLimitBytes: null,
        memoryPercent: null,
        observedAt: new Date(observed).toISOString(),
      };
      // Freshness is the oldest participating metric, not the newest limit gauge.
      row.observedAt = new Date(Math.min(Date.parse(row.observedAt), observed)).toISOString();
      if (metric === 0) row.cpuCores = value / 1e9;
      if (metric === 1 && value > 0) row.cpuLimitCores = value / 1e9;
      if (metric === 2) row.memoryBytes = value;
      if (metric === 3 && value > 0) row.memoryLimitBytes = value;
      instances.set(key, row);
    }
  return [...instances.values()]
    .map(r => ({
      ...r,
      cpuPercent:
        r.cpuCores !== null && r.cpuLimitCores ? (100 * r.cpuCores) / r.cpuLimitCores : null,
      memoryPercent:
        r.memoryBytes !== null && r.memoryLimitBytes
          ? (100 * r.memoryBytes) / r.memoryLimitBytes
          : null,
    }))
    .filter(r => r.cpuCores !== null || r.memoryBytes !== null);
}

export function createResourceReader(env: Env = process.env, fetcher = fetch, now = Date.now) {
  const scope = {
    environment: env.VISHNU_DATADOG_ENV ?? 'synthetic',
    deployment:
      env.VISHNU_DATADOG_SCOPE === 'environment'
        ? 'all'
        : (env.VISHNU_DATADOG_DEPLOYMENT ?? `slot-${env.VISHNU_SLOT ?? '0'}`),
    ...(env.VISHNU_DATADOG_MACHINE ? { machine: env.VISHNU_DATADOG_MACHINE } : {}),
  };
  let cached: ResourceSnapshot | undefined, pending: Promise<ResourceSnapshot> | undefined;
  const collect = async (): Promise<ResourceSnapshot> => {
    const to = now(),
      from = to - 5 * 60_000;
    const base: ResourceSnapshot = {
      status: 'unconfigured',
      source: 'datadog',
      scope,
      observedAt: new Date(to).toISOString(),
      window: { from, to },
      instances: [],
      message: 'Datadog credentials are not configured.',
    };
    if (!env.DD_API_KEY || !env.DD_APP_KEY) return base;
    const site = env.DD_SITE ?? 'datadoghq.com';
    if (!sites.has(site) || !Object.values(scope).every(x => safe.test(x)))
      return { ...base, status: 'unavailable', message: 'Invalid resource scope.' };
    // Native ss processes are not ECS containers. Do not substitute their host's usage.
    if (scope.environment === 'synthetic')
      return {
        ...base,
        status: 'empty',
        message:
          'Native synthetic processes do not yet publish per-process CPU and memory to Datadog. Host totals are not attributed to individual services.',
      };
    if (!['dev', 'prod'].includes(scope.environment))
      return { ...base, status: 'unavailable', message: 'Unsupported resource environment.' };
    const filter = `env:${scope.environment}${scope.deployment === 'all' ? '' : `,task_family:*-${scope.deployment}`}`;
    try {
      const results = await Promise.all(
        metrics.map(async metric => {
          const url = new URL('/api/v1/query', `https://api.${site}`);
          url.search = new URLSearchParams({
            from: String(Math.floor(from / 1000)),
            to: String(Math.floor(to / 1000)),
            query: `avg:${metric}{${filter}} by {env,container_id,ecs_container_name,task_family}`,
          }).toString();
          const response = await fetcher(url, {
            headers: { 'DD-API-KEY': env.DD_API_KEY!, 'DD-APPLICATION-KEY': env.DD_APP_KEY! },
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) throw new Error('Resource query failed');
          const body = await response.text();
          if (body.length > 2_000_000) throw new Error('Resource query too large');
          const data = JSON.parse(body);
          if (!Array.isArray(data.series)) throw new Error('Invalid resource response');
          // Recheck every returned series against the requested scope before joining it.
          return data.series
            .filter((s: Series) => s.tag_set?.includes(`env:${scope.environment}`))
            .filter(
              (s: Series) =>
                scope.deployment === 'all' ||
                s.tag_set?.some(
                  t => t.startsWith('task_family:') && t.endsWith(`-${scope.deployment}`)
                )
            ) as Series[];
        })
      );
      const instances = parseResources(results, to);
      return {
        ...base,
        status: instances.length ? 'ready' : 'empty',
        instances,
        message: instances.length
          ? 'Five-minute averages per container. Deployment is the ECS task family. Percentages use reported container limits; missing limits remain unknown.'
          : 'No fresh container resource measurements in this scope.',
      };
    } catch {
      return {
        ...base,
        status: 'unavailable',
        message: 'Datadog resource measurements are unavailable; retrying.',
      };
    }
  };
  return () => {
    if (cached && now() - Date.parse(cached.observedAt) < 60_000) return Promise.resolve(cached);
    pending ??= collect()
      .then(value => (cached = value))
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
