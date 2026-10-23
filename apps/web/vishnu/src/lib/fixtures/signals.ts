import { createFixture } from './mesh';
import type { Relationship } from '../graph/types';
export type DemoKind = 'hot' | 'slow' | 'fanout';
export interface DemoSignal { kind: DemoKind; value: number; budget: number; unit: string; detail: string }
export const signalColors = { hot: 'var(--color-teal)', slow: 'var(--color-attention)', fanout: 'var(--chart-2)' };
export const signalNames = { hot: 'Hot traffic', slow: 'Slow path', fanout: 'Fan-out' };
export const demoSignals: Record<string, DemoSignal> = {
  'dash-programs': { kind: 'hot', value: 180, budget: 200, unit: 'requests/s', detail: 'Traffic is up from 95 requests/s. Approaching the illustrative 200 requests/s capacity budget; no errors yet.' },
  'staff-iam': { kind: 'hot', value: 80, budget: 200, unit: 'requests/s', detail: 'A quieter path at 40% of the same capacity budget. Lower opacity indicates more headroom.' },
  'demo-iam-programs': { kind: 'slow', value: 780, budget: 1000, unit: 'ms p95', detail: 'IAM calls Programs twice per root request. p95 rose from 420 ms to 780 ms, approaching the illustrative 1-second latency budget.' },
  'dash-scheduling': { kind: 'slow', value: 460, budget: 1000, unit: 'ms p95', detail: '46% of the latency budget: visible context, with more headroom than the IAM → Programs path.' },
  'demo-programs-scheduling': { kind: 'fanout', value: 50, budget: 60, unit: 'calls / IAM request', detail: 'One IAM request calls Programs twice; each Programs call makes 25 Scheduling calls: 2 × 25 = 50 calls per IAM root request. The illustrative budget is 60. This is a simulated causal chain, not a ratio inferred from global traffic.' },
};
export const signalDegree = (s: DemoSignal) => Math.max(0, s.value / s.budget);
export const signalOpacity = (s: DemoSignal) => 0.35 + 0.65 * Math.min(1, signalDegree(s));
export const signalColor = (s: DemoSignal) => signalDegree(s) >= 1 ? 'var(--color-danger)' : signalColors[s.kind];
export function createSignalDemo() {
  const mesh = createFixture('overview');
  mesh.topologyVersion = 'standup-signals-v1';
  mesh.environment = 'Simulated demo';
  mesh.systems.find(s => s.id === 'staff')!.label = 'Coach';
  mesh.relationships.push(...[
    ['demo-iam-programs', 'iam', 'programs', 'IAM → Programs · 2 calls / request'],
    ['demo-programs-scheduling', 'programs', 'scheduling', 'Programs → Scheduling · 25 calls / Programs request'],
  ].map(([id,source,target,label]): Relationship => ({id,source,target,label,kind:'http',protocol:'trpc',count:null,rate:null,latencyMs:null,health:'healthy',freshness:'fresh',summary:'Invented causal path for the stand-up demonstration.',evidence:[]})));
  for (const r of mesh.relationships) {
    const s = demoSignals[r.id];
    r.rate = s?.kind === 'hot' ? s.value : null;
    r.latencyMs = s?.kind === 'slow' ? s.value : null;
    r.health = s && signalDegree(s) >= .7 ? 'warning' : 'healthy';
    r.summary = s?.detail ?? 'Illustrative context path; no simulated signal assigned.';
    r.evidence = [{label:'SIMULATED — not live telemetry',description:r.summary}];
  }
  return mesh;
}
