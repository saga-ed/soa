import type { System, Relationship } from './types';

/** Shared by node rendering and layout for fixture and local infrastructure IDs. */
export function systemShape(system: System): 'service' | 'database' | 'cache' | 'bus' {
  const identity = `${system.id} ${system.label} ${system.kind}`.toLowerCase();
  if (/rabbitmq|shared broker/.test(identity)) return 'bus';
  if (/postgres/.test(identity)) return 'database';
  if (/redis/.test(identity)) return 'cache';
  return 'service';
}

export function layoutRank(system: System): number {
  if (systemShape(system) === 'bus') return 0;
  return { data: 1, mesh: 2, application: 3 }[system.band];
}

export function connectionLabel(relationship: Relationship): string {
  if (relationship.kind === 'dependency') return 'APM';
  if (relationship.kind === 'event') return 'MQ';
  if (relationship.kind === 'database') return 'DB';
  return { trpc: 'HTTP/tRPC', rest: 'HTTP/REST', mixed: 'HTTP/tRPC + REST', unknown: 'HTTP/?' }[relationship.protocol ?? 'unknown'];
}
