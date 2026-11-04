import type { DatadogSnapshot } from './datadog';
/** An independent counter bucket can remain current when the slower trace sample is stale. */
export function pathRates(
  data: DatadogSnapshot | null,
  source: string,
  target: string,
  now: number,
  failed = false
) {
  const unavailable = { state: 'unavailable' as const, rows: [], value: null, window: null };
  if (
    !data ||
    failed ||
    data.pathRateSource !== 'application-counter' ||
    !['available', 'partial'].includes(data.pathRateStatus ?? '')
  )
    return unavailable;
  const at = Date.parse(data.pathRateObservedAt ?? '');
  const freshness = data.pathRateFreshForMs;
  const window = data.pathRateWindow;
  if (
    !Number.isFinite(at) ||
    !freshness ||
    !Number.isFinite(freshness) ||
    freshness <= 0 ||
    at > now + 60_000 ||
    now - at > freshness ||
    !window ||
    !Number.isFinite(window.from) ||
    !Number.isFinite(window.to) ||
    window.from >= window.to ||
    window.to > now + 60_000 ||
    now - window.to > freshness
  )
    return { ...unavailable, state: 'stale' as const };
  const candidates = (data.pathRates ?? []).filter(
    row => row.source === source && row.target === target
  );
  const rows = candidates.filter(
    row =>
      row.rate.at === window.to &&
      Number.isFinite(row.rate.value) &&
      row.rate.value >= 0 &&
      Number.isFinite(row.count) &&
      row.count >= 0
  );
  if (!rows.length) return { ...unavailable, state: 'missing' as const, window };
  return {
    state:
      data.pathRateStatus === 'partial' || rows.length < candidates.length
        ? ('partial' as const)
        : ('available' as const),
    rows,
    value: rows.reduce((total, row) => total + row.rate.value, 0),
    window,
  };
}
