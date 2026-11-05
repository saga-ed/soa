/** Declarative data only: neither the browser nor the model executes chart code. */
export type ChartTime =
  | { mode: 'rolling'; minutes: number }
  | { mode: 'fixed'; from: string; to: string };
export type ChartSpec = {
  id: string;
  title: string;
  system: string;
  kind: 'line' | 'histogram' | 'scatter';
  metric: 'cpu' | 'memory' | 'cpu_memory' | 'latency';
  statistics: ('avg' | 'max' | 'p95')[];
  time: ChartTime;
  group: 'service' | 'instance';
  population: 'observations' | 'rollups';
};
export type ChartScope = { environment: string; deployment: string; machine?: string };
export type ChartSeries = {
  name: string;
  unit: string;
  points: [number, number | null][];
  instance?: string;
};
export type ChartResult = {
  status: 'ready' | 'empty' | 'unconfigured' | 'unavailable';
  source: 'datadog';
  scope: ChartScope;
  window: { from: number; to: number };
  observedAt: string;
  intervalSeconds: number;
  message: string;
  link: string;
  series: ChartSeries[];
  bins?: { name: string; unit: string; buckets: { from: number; to: number; count: number }[] }[];
  pairs?: { instance: string; time: number; cpu: number; memory: number }[];
};
export type ChartSet = { version: 1; charts: ChartSpec[]; meshCollapsed: boolean };
export type SavedChartView = {
  id: string;
  name: string;
  revision: number;
  definition: ChartSet;
  updatedAt: string;
};

/** Pair only the same timestamp and replica. Missing observations never become zero. */
export function alignResourcePairs(series: ChartSeries[]) {
  const pairs: NonNullable<ChartResult['pairs']> = [];
  for (const cpu of series.filter(s => s.unit === 'cores')) {
    const memory = series.find(s => s.unit === 'MiB' && s.instance === cpu.instance);
    const values = new Map(memory?.points ?? []);
    for (const [time, value] of cpu.points) {
      const mem = values.get(time);
      if (value !== null && mem !== null && mem !== undefined)
        pairs.push({ instance: cpu.instance ?? 'service', time, cpu: value, memory: mem });
    }
  }
  return pairs;
}
export function histogram(values: number[], count = 20) {
  const finite = values.filter(v => Number.isFinite(v) && v >= 0);
  if (!finite.length) return [];
  const max = Math.max(...finite),
    width = max > 0 ? max / count : 1;
  const buckets = Array.from({ length: max > 0 ? count : 1 }, (_, i) => ({
    from: i * width,
    to: (i + 1) * width,
    count: 0,
  }));
  for (const value of finite)
    buckets[Math.min(buckets.length - 1, Math.floor(value / width))].count++;
  return buckets;
}
