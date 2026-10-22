import type { MeshSnapshot } from './types';
export function busParticipants(snapshot: MeshSnapshot) {
  return snapshot.systems.map(system => ({
    system,
    publishes: !!system.eventBus?.publishes || snapshot.relationships.some(r => r.kind === 'event' && r.source === system.id),
    consumes: !!system.eventBus?.consumes || snapshot.relationships.some(r => r.kind === 'event' && r.target === system.id),
  })).filter(p => p.publishes || p.consumes).sort((a, b) => a.system.label.localeCompare(b.system.label));
}
export const busPanelHeight = (count: number) => 104 + Math.max(1, count) * 100;

export function busRole(p: { publishes: boolean; consumes: boolean }): string {
  return p.publishes && p.consumes ? 'Producer + Consumer' : p.publishes ? 'Producer' : 'Consumer';
}

export function busBadge(p: { publishes: boolean; consumes: boolean }): string {
 return p.publishes && p.consumes ? 'MQ-P/C' : p.publishes ? 'MQ-P' : 'MQ-C';
}
