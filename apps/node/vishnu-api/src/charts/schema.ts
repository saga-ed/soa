import { z } from 'zod';
export const ChartTime = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('rolling'), minutes: z.number().int().min(5).max(43_200) }).strict(),
  z.object({ mode: z.literal('fixed'), from: z.iso.datetime(), to: z.iso.datetime() }).strict(),
]);
export const Chart = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(100),
    system: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/),
    kind: z.enum(['line', 'histogram', 'scatter']),
    metric: z.enum(['cpu', 'memory', 'cpu_memory', 'latency']),
    statistics: z
      .array(z.enum(['avg', 'max', 'p95']))
      .min(1)
      .max(3),
    time: ChartTime,
    group: z.enum(['service', 'instance']),
    population: z.enum(['observations', 'rollups']),
  })
  .strict()
  .superRefine((c, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.kind === 'scatter' && c.metric !== 'cpu_memory')
      invalid('Scatter requires CPU and memory.');
    if (c.kind === 'histogram' && c.metric === 'cpu_memory')
      invalid('Use separate CPU and memory histograms.');
    if (c.metric === 'latency' && c.group !== 'service')
      invalid('Latency charts use service scope.');
    if (c.metric !== 'latency' && (c.statistics.length !== 1 || c.statistics[0] !== 'avg'))
      invalid('Resource charts use interval averages.');
    if (new Set(c.statistics).size !== c.statistics.length) invalid('Duplicate statistic.');
    if (c.time.mode === 'fixed') {
      const duration = Date.parse(c.time.to) - Date.parse(c.time.from);
      if (duration < 300_000 || duration > 30 * 86_400_000)
        invalid('Choose a window between 5 minutes and 30 days.');
    }
  });
export const ChartSet = z
  .object({
    version: z.literal(1),
    charts: z.array(Chart).min(1).max(8),
    meshCollapsed: z.boolean(),
  })
  .strict()
  .refine(c => new Set(c.charts.map(s => s.id)).size === c.charts.length, 'Duplicate chart ID.');
export const SaveView = z
  .object({
    name: z.string().trim().min(1).max(100),
    definition: ChartSet,
    revision: z.number().int().positive().optional(),
  })
  .strict();
export function resolveWindow(time: z.infer<typeof ChartTime>, now = Date.now()) {
  const to = time.mode === 'rolling' ? Math.floor(now / 60_000) * 60_000 : Date.parse(time.to);
  const from = time.mode === 'rolling' ? to - time.minutes * 60_000 : Date.parse(time.from);
  if (
    to > now ||
    from < now - 31 * 86_400_000 ||
    to - from < 300_000 ||
    to - from > 30 * 86_400_000
  )
    throw new Error('Window must cover 5 minutes to 30 days within the last 31 days.');
  return { from, to };
}
