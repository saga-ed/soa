import type { Counter } from '@saga-ed/soa-event-stats';
import { numberLabel, type ServiceStats } from './event-stats';
const counters: { key: Counter; label: string; role: 'producer' | 'consumer' }[] = [
  { key: 'publishAccepted', label: 'Accepted', role: 'producer' },
  { key: 'publishConfirmed', label: 'Confirmed', role: 'producer' },
  { key: 'deliveries', label: 'Deliveries', role: 'consumer' },
  { key: 'commits', label: 'Committed', role: 'consumer' },
  { key: 'redeliveries', label: 'Redeliveries', role: 'consumer' },
  { key: 'requeues', label: 'Requeue requests', role: 'consumer' },
];
/** These are service→bus and bus→service counters, never inferred end-to-end edge traffic. */
export function eventRates(view: ServiceStats | undefined, role?: 'producer' | 'consumer') {
  return counters
    .filter(c => !role || c.role === role)
    .map(c => {
      const row = view?.rows.find(r => r.key === c.key);
      const value =
        view?.status === 'Live' && row?.rate != null && Number.isFinite(row.rate) && row.rate >= 0
          ? row.rate
          : null;
      return {
        ...c,
        value,
        labelled: `${c.label} ${numberLabel(value, true)}/s`,
        coverage: row?.rateCoverage,
      };
    });
}
export function eventRateLabel(
  view: ServiceStats | undefined,
  publishes: boolean,
  consumes: boolean
) {
  const rows = eventRates(view);
  return [publishes ? rows[0] : null, consumes ? rows[2] : null]
    .filter(row => row != null)
    .map(row => row!.labelled)
    .join(' · ');
}
