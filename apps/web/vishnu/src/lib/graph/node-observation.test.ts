import { describe, it, expect } from 'vitest';
import { nodeObservation } from './node-observation';
import { serviceSignal } from './datadog';
import { serviceStats } from './event-stats';
import { createFixture } from '../fixtures/mesh';

const system = { ...createFixture('overview').systems[0], health: 'unknown' as const, observationSource: 'declared' as const, freshness: 'missing' as const };
const signal = serviceSignal(null, system.id, 0);
describe('node evidence labels', () => {
 it('does not claim health from live reporting or APM observations', () => {
  const mq = { ...serviceStats(null, system.id), status: 'Live', stale: 3 };
  expect(nodeObservation(system, {...signal, observed: true}, mq, true)).toEqual({label:'APM observed · MQ reporting',risk:'unknown'});
 });
 it('keeps alerts prominent alongside telemetry liveness', () => {
  expect(nodeObservation(system, {...signal, flagged:true, risk:'critical'}, undefined, true)).toEqual({label:'! APM alert',risk:'critical'});
 });
 it('distinguishes stale evidence from declarations without reports', () => {
  expect(nodeObservation(system,signal,undefined,true).label).toBe('Declared only');
  expect(nodeObservation(system,{...signal,stale:true},{...serviceStats(null,system.id),status:'Stale'},true).label).toBe('APM stale · MQ stale');
 });
 it('distinguishes a failed refresh from aged observations', () => {
  const failed = serviceSignal(null, system.id, 0, true);
  expect(failed.stale).toBe(false);
  expect(nodeObservation(system, failed, undefined, true).label).toBe('APM unavailable');
 });
 it('preserves fixture health labels', () => {
  expect(nodeObservation({...system,health:'critical'},signal,undefined,false).label).toBe('critical');
 });
});
