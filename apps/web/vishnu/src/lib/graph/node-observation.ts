import type { System } from './types';
import type { serviceSignal } from './datadog';
import type { ServiceStats } from './event-stats';

/** Describe available evidence without promoting telemetry liveness to health. */
export function nodeObservation(system: System, signal: ReturnType<typeof serviceSignal>, mq: ServiceStats | undefined, live: boolean) {
  if (!live) return { label: system.health, risk: system.health };
  const evidence: string[] = [];
  if (signal.flagged) evidence.push(signal.risk === 'critical' ? '! APM alert' : '▲ APM warning');
  else if (signal.observed) evidence.push('APM observed');
  if (signal.stale) evidence.push('APM stale');
  if (mq?.status === 'Live') evidence.push('MQ reporting');
  else if (mq?.status === 'Stale') evidence.push('MQ stale');
  else if (mq?.status === 'Unavailable' && system.eventBus) evidence.push('MQ unavailable');
  if (system.runtimeState) evidence.unshift(system.runtimeState.replaceAll('-', ' '));
  else if (system.health === 'healthy') evidence.unshift('Reachable');
  if (!evidence.length) evidence.push(system.freshness === 'stale' ? 'Telemetry stale' : system.observationSource === 'declared' ? 'Declared only' : 'No current telemetry');
  return { label: evidence.join(' · '), risk: signal.flagged ? signal.risk : system.health };
}
