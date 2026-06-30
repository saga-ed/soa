/**
 * Mesh host-port preflight — conflict logic (plan §7.2 M4; up.sh check_ports).
 *
 * The two probe sources (docker-ps + raw listener) are behind the injectable
 * `PortProbe`, so this asserts the conflict classification with NO docker/socket
 * IO: a mesh-owned container is fine, a foreign container is a `docker` conflict,
 * a non-docker listener is a `native` conflict, and a free port is clear.
 */

import { describe, expect, it } from 'vitest';
import { manifest } from '../../core/manifest/index.js';
import {
  checkPorts,
  meshOwnedContainers,
  meshPortSpecs,
} from '../preflight.js';
import type { PortProbe } from '../preflight.js';

/** A fake probe: `docker` maps port→container, `native` is the set of raw listeners. */
function fakeProbe(docker: Record<number, string>, native: number[] = []): PortProbe {
  const nativeSet = new Set(native);
  return {
    async dockerHolder(port) {
      return docker[port] ?? null;
    },
    async listening(port) {
      return nativeSet.has(port);
    },
  };
}

describe('meshPortSpecs / meshOwnedContainers', () => {
  it('derives the 5 mesh host ports from the manifest (incl. rabbitmq-mgmt + connect-mongo)', () => {
    const specs = meshPortSpecs(manifest);
    expect(specs).toEqual([
      { port: 5432, name: 'postgres' },
      { port: 6379, name: 'redis' },
      { port: 5672, name: 'rabbitmq' },
      { port: 15672, name: 'rabbitmq-mgmt' },
      { port: 27037, name: 'connect-mongo' },
    ]);
  });

  it('owns the manifest mesh container names', () => {
    const owned = meshOwnedContainers(manifest);
    expect(owned.has('soa-postgres-1')).toBe(true);
    expect(owned.has('soa-connect-mongo-1')).toBe(true);
  });
});

describe('checkPorts', () => {
  const specs = meshPortSpecs(manifest);
  const owned = meshOwnedContainers(manifest);

  it('reports no conflicts when every port is free', async () => {
    const conflicts = await checkPorts(specs, fakeProbe({}), owned);
    expect(conflicts).toEqual([]);
  });

  it('skips ports held by our own mesh containers', async () => {
    const probe = fakeProbe({ 5432: 'soa-postgres-1', 27037: 'soa-connect-mongo-1' });
    const conflicts = await checkPorts(specs, probe, owned);
    expect(conflicts).toEqual([]);
  });

  it('flags a foreign docker container as a docker conflict (named, with remedy)', async () => {
    const probe = fakeProbe({ 5432: 'some-other-pg' });
    const conflicts = await checkPorts(specs, probe, owned);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ port: 5432, name: 'postgres', kind: 'docker', holder: 'some-other-pg' });
    expect(conflicts[0].message).toContain('docker stop some-other-pg');
  });

  it('flags a non-docker listener as a native conflict', async () => {
    const probe = fakeProbe({}, [6379]);
    const conflicts = await checkPorts(specs, probe, owned);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ port: 6379, name: 'redis', kind: 'native' });
    expect(conflicts[0].message).toContain('non-docker listener');
  });

  it('names ALL conflicts in one pass (does not bail on the first)', async () => {
    const probe = fakeProbe({ 5432: 'foo' }, [6379, 5672]);
    const conflicts = await checkPorts(specs, probe, owned);
    expect(conflicts.map((c) => c.port)).toEqual([5432, 6379, 5672]);
  });

  it('prefers the docker holder over the listener check for the same port', async () => {
    // docker maps it AND it listens — up.sh reports the (named) container, not native.
    const probe = fakeProbe({ 5672: 'foreign-rabbit' }, [5672]);
    const conflicts = await checkPorts(specs, probe, owned);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('docker');
  });
});
