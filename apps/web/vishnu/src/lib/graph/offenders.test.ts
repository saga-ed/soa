import { describe, expect, it } from 'vitest';
import { normalizeTopN, rankOffenders } from './offenders';
import type { DatadogSnapshot } from './datadog';
const now = Date.parse('2026-11-02T12:00:00Z');
const data = {
 version:1, message:'test', serverNow:now, scope:{environment:'synthetic',deployment:'slot-3',deploymentTag:'deployment.identifier'}, appUrl:'https://app.datadoghq.com', window:{from:now-900000,to:now}, thresholds:{hotRate:10,warningP95Ms:2500,criticalP95Ms:5000}, services:[], dependencies:[],
 status: 'partial', observedAt: new Date(now).toISOString(), freshForMs: 180000,
 pathEndpointStatus: 'available', pathEndpoints: [
  {source:'a',target:'b',resource:'GET slow',observedSpans:2,p95Ms:80},
  {source:'a',target:'b',resource:'GET hot',observedSpans:50,p95Ms:10},
  {source:'b',target:'a',resource:'GET reverse',observedSpans:999,p95Ms:999},
  {source:'a',target:'c',resource:'GET other',observedSpans:999,p95Ms:999},
  {source:'a',target:'b',resource:'GET unknown',observedSpans:5,p95Ms:null},
 ],
 fanoutCoverage:{requestedTraces:2,retrievedTraces:2,usableTraces:2,rejectedTraces:0,limited:true,basis:'recent-retained-trace-sample',observedAt:new Date(now).toISOString()},
 fanoutStatus:'available', fanout: [
  {source:'a',target:'b',resource:'GET child',parentResource:'GET parent-low',sampledParents:2,observedCalls:4,maxCallsPerParent:3,meanCallsPerParent:2,traceIds:[]},
  {source:'a',target:'b',resource:'GET child',parentResource:'GET parent-high',sampledParents:2,observedCalls:10,maxCallsPerParent:6,meanCallsPerParent:5,traceIds:[]},
  {source:'a',target:'c',resource:'GET foreign',parentResource:'GET other',sampledParents:2,observedCalls:100,maxCallsPerParent:90,meanCallsPerParent:50,traceIds:[]},
 ],
} as DatadogSnapshot;
describe('path endpoint rankings', () => {
 it('ranks exact directed path by retained latency or count with configured limit', () => {
  const slow=rankOffenders(data,'a','b','slow',1,now);
  expect(slow.rows.map(r=>r.resource)).toEqual(['GET slow']);
  expect(slow.total).toBe(2);
  expect(rankOffenders(data,'a','b','hot',5,now).rows.map(r=>r.resource)).toEqual(['GET hot','GET unknown','GET slow']);
 });
 it('ranks fanout by measured calls per sampled parent and preserves parent endpoints', () => {
  const result=rankOffenders(data,'a','b','fanout',5,now);
  expect(result.rows.map(r=>r.parentResource)).toEqual(['GET parent-high','GET parent-low']);
  expect(result.rows[0]).toMatchObject({value:5,observedCalls:10,sampledParents:2});
 });
 it('does not substitute service metrics or absent scope evidence', () => {
  expect(rankOffenders({...data,pathEndpoints:[]},'a','b','hot',5,now).state).toBe('empty');
  expect(rankOffenders({...data,pathEndpointStatus:undefined},'a','b','hot',5,now).state).toBe('unavailable');
  expect(rankOffenders(null,'a','b','slow',5,now).state).toBe('unavailable');
  expect(rankOffenders(data,'a','b','slow',5,now,true).state).toBe('unavailable');
  expect(rankOffenders(data,'a','b','slow',5,now,false,false).state).toBe('unsupported');
 });
 it('suppresses stale or invalid observation times and preserves partial results', () => {
  expect(rankOffenders(data,'a','b','slow',5,now+180001).state).toBe('stale');
  expect(rankOffenders({...data,observedAt:'invalid'},'a','b','slow',5,now).state).toBe('stale');
  expect(rankOffenders({...data,pathEndpointStatus:'partial'},'a','b','slow',5,now).state).toBe('partial');
  expect(rankOffenders({...data,fanoutCoverage:{observedAt:new Date(now-180001).toISOString()} as DatadogSnapshot['fanoutCoverage']},'a','b','fanout',5,now).state).toBe('stale');
 });
 it('rejects missing fanout timestamps and malformed numeric observations', () => {
  expect(rankOffenders({...data,fanoutCoverage:undefined},'a','b','fanout',5,now).state).toBe('unavailable');
  expect(rankOffenders({...data,fanout:data.fanout!.map(row=>({...row,meanCallsPerParent:-1}))},'a','b','fanout',5,now).rows).toEqual([]);
  expect(rankOffenders({...data,pathEndpoints:data.pathEndpoints!.map(row=>({...row,observedSpans:Infinity}))},'a','b','hot',5,now).rows).toEqual([]);
  expect(rankOffenders({...data,pathEndpoints:data.pathEndpoints!.map(row=>({...row,p95Ms:-1}))},'a','b','slow',5,now).rows).toEqual([]);
 });
 it('normalizes stored settings and enforces limits', () => {
  expect([undefined,null,'','oops'].map(normalizeTopN)).toEqual([5,5,5,5]);
  expect(['3','0','999','2.9'].map(normalizeTopN)).toEqual([3,1,50,2]);
 });
});
