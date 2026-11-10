import { ReportSchema, type Counter, type Counters, type Report } from './contract.js';

export interface ReportComparison {
  readonly status: 'baseline' | 'ignored' | 'advanced';
  readonly intervalMs: number | null;
  readonly streams: ReadonlyArray<{
    readonly stream: Report['streams'][number]['stream'];
    readonly deltas: Counters;
    readonly rates: Counters;
  }>;
}
const key = (s: Report['streams'][number]['stream']) =>
  JSON.stringify([
    s.role,
    s.exchange,
    s.queue ?? null,
    s.consumer ?? null,
    s.eventType,
    s.eventVersion ?? null,
  ]);

/** Reference receiver calculation. Persistence, freshness and retention belong to the receiver. */
export function compareReports(previous: Report | undefined, incoming: Report): ReportComparison {
  const current = ReportSchema.parse(incoming);
  if (previous) previous = ReportSchema.parse(previous);
  const sameIdentity =
    previous &&
    Object.keys(current.identity).every(
      k =>
        current.identity[k as keyof typeof current.identity] ===
        previous?.identity[k as keyof typeof current.identity]
    );
  if (
    previous &&
    sameIdentity &&
    current.epoch === previous.epoch &&
    (current.sequence <= previous.sequence || current.elapsedMs < previous.elapsedMs)
  ) {
    return { status: 'ignored', intervalMs: null, streams: [] };
  }
  const baseline = !previous || !sameIdentity || current.epoch !== previous.epoch;
  const intervalMs = baseline ? null : current.elapsedMs - previous!.elapsedMs;
  const old = new Map(baseline ? [] : previous!.streams.map(s => [key(s.stream), s]));
  return {
    status: baseline ? 'baseline' : 'advanced',
    intervalMs,
    streams: current.streams.map(s => {
      const prior = old.get(key(s.stream));
      const deltas = {} as Counters;
      const rates = {} as Counters;
      for (const counter of Object.keys(s.counters) as Counter[]) {
        const a = prior?.counters[counter];
        const b = s.counters[counter];
        const delta =
          typeof a === 'number' && typeof b === 'number' && b >= a && b < Number.MAX_SAFE_INTEGER
            ? b - a
            : null;
        deltas[counter] = delta;
        rates[counter] =
          delta !== null && intervalMs !== null && intervalMs > 0
            ? (delta * 1000) / intervalMs
            : null;
      }
      return { stream: s.stream, deltas, rates };
    }),
  };
}
