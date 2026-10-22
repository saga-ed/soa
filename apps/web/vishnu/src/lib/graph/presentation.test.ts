import { describe, expect, it } from 'vitest';
import { connectionLabel } from './presentation';
import { busParticipants, busRole, busBadge } from './bus';
import { createFixture } from '../fixtures/mesh';

describe('transport and bus roles', () => {
  it('shows source-verified dual roles even when the launch manifest has no event edges', () => {
    const snapshot = createFixture();
    snapshot.relationships = snapshot.relationships.filter(r => r.kind !== 'event');
    snapshot.systems.find(s => s.id === 'programs')!.eventBus = { publishes: true, consumes: true };
    const participants = busParticipants(snapshot);
    expect(participants.map(p => p.system.id)).toEqual(['programs']);
    expect(busBadge(participants[0])).toBe('MQ-P/C');
    expect(busBadge({ publishes: true, consumes: false })).toBe('MQ-P');
    expect(busBadge({ publishes: false, consumes: true })).toBe('MQ-C');
  });
  it('keeps unverified HTTP distinct from REST and represents mixed transports', () => {
    const edge = createFixture().relationships.find(r => r.kind === 'http')!;
    expect(connectionLabel({ ...edge, protocol: undefined })).toBe('HTTP/?');
    expect(connectionLabel({ ...edge, protocol: 'trpc' })).toBe('HTTP/tRPC');
    expect(connectionLabel({ ...edge, protocol: 'rest' })).toBe('HTTP/REST');
    expect(connectionLabel({ ...edge, protocol: 'mixed' })).toBe('HTTP/tRPC + REST');
  });
  it('derives producer, consumer, and dual roles from directed event paths only', () => {
    const fixture = createFixture();
    const roles = busParticipants(fixture);
    expect(busRole(roles.find(p => p.system.id === 'iam')!)).toBe('Producer');
    expect(busRole(roles.find(p => p.system.id === 'programs')!)).toBe('Producer + Consumer');
    const oneWay = { ...fixture, relationships: fixture.relationships.filter(r => r.kind !== 'event' || r.source === 'iam') };
    expect(busRole(busParticipants(oneWay).find(p => p.system.id === 'programs')!)).toBe('Consumer');
    expect(roles.some(p => p.system.id === 'dash')).toBe(false);
  });
});
