/**
 * Native mesh bring-up — meshUp orchestration (plan §7.2 M4; up.sh mesh_up).
 *
 * The Runner (`make up`), the readiness exec, and the port probe are all
 * injected, so this asserts: the preflight aborts before `make up` on a conflict,
 * the `make up` invocation is manifest-faithful (cwd/args/env), readiness gates
 * only the requested units, and a never-ready unit fails the result — all with NO
 * real make/docker.
 */

import { describe, expect, it } from 'vitest';
import { manifest } from '../../core/manifest/index.js';
import type { RunResult, Runner, ScriptInvocation } from '../exec.js';
import { meshDownArgs, meshMakeArgs, meshUp } from '../mesh.js';
import type { MeshExec } from '../mesh.js';
import type { PortProbe } from '../preflight.js';

const SOA = '/repo/soa';

/** A Runner that records the invocation and returns a canned code. */
function fakeRunner(code = 0): { runner: Runner; calls: ScriptInvocation[] } {
  const calls: ScriptInvocation[] = [];
  const runner: Runner = {
    async run(spec): Promise<RunResult> {
      calls.push(spec);
      return { code };
    },
  };
  return { runner, calls };
}

/** A readiness exec where `ready[container]` decides; default ready. */
function fakeExec(ready: Record<string, boolean> = {}): { exec: MeshExec; calls: string[] } {
  const calls: string[] = [];
  const exec: MeshExec = {
    async ready(container) {
      calls.push(container);
      return ready[container] ?? true;
    },
  };
  return { exec, calls };
}

const FREE_PROBE: PortProbe = {
  async dockerHolder() {
    return null;
  },
  async listening() {
    return false;
  },
};

describe('meshMakeArgs', () => {
  it('builds the manifest-derived make argv', () => {
    expect(meshMakeArgs(manifest)).toEqual([
      'up',
      'PROJECT=saga-mesh',
      'PROFILE=empty',
      'POSTGRES_PORT=5432',
      'REDIS_PORT=6379',
      'RABBITMQ_PORT=5672',
      'RABBITMQ_MGMT_PORT=15672',
      'CONNECT_MONGO_PORT=27037',
    ]);
  });

  it('M7 slot 0 (no opts / project+offset 0) is byte-identical', () => {
    expect(meshMakeArgs(manifest, { offset: 0 })).toEqual(meshMakeArgs(manifest));
  });

  it('M7 slot > 0: prepends COMPOSE_PROJECT_NAME + offsets every mesh port', () => {
    expect(meshMakeArgs(manifest, { project: 'soa-s1', offset: 1000 })).toEqual([
      'up',
      'COMPOSE_PROJECT_NAME=soa-s1',
      'PROJECT=saga-mesh',
      'PROFILE=empty',
      'POSTGRES_PORT=6432',
      'REDIS_PORT=7379',
      'RABBITMQ_PORT=6672',
      'RABBITMQ_MGMT_PORT=16672',
      'CONNECT_MONGO_PORT=28037',
    ]);
  });

  it('two slots (1 vs 2) emit non-colliding mesh port args', () => {
    const portsOf = (a: string[]): string[] => a.filter((x) => x.endsWith('_PORT') === false && /_PORT=/.test(x));
    const s1 = portsOf(meshMakeArgs(manifest, { project: 'soa-s1', offset: 1000 }));
    const s2 = portsOf(meshMakeArgs(manifest, { project: 'soa-s2', offset: 2000 }));
    const vals1 = s1.map((x) => x.split('=')[1]);
    const vals2 = s2.map((x) => x.split('=')[1]);
    expect(vals1.some((v) => vals2.includes(v))).toBe(false);
  });
});

describe('meshDownArgs', () => {
  it('slot 0 (no project) is byte-identical to the pre-M7 form', () => {
    expect(meshDownArgs()).toEqual(['down', 'PROJECT=saga-mesh']);
  });

  it('slot > 0: passes the per-slot COMPOSE_PROJECT_NAME (tears down the right project)', () => {
    expect(meshDownArgs({ project: 'soa-s1' })).toEqual([
      'down',
      'COMPOSE_PROJECT_NAME=soa-s1',
      'PROJECT=saga-mesh',
    ]);
  });
});

describe('meshUp', () => {
  it('runs make up in <soa>/infra with the seed-dir env, then gates readiness', async () => {
    const { runner, calls } = fakeRunner(0);
    const { exec } = fakeExec();
    const res = await meshUp({
      soaRoot: SOA,
      runner,
      exec,
      portProbe: FREE_PROBE,
      units: ['postgres', 'rabbitmq'],
    });

    expect(res.ok).toBe(true);
    expect(res.makeOk).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/repo/soa/infra');
    expect(calls[0].command).toBe('make');
    expect(calls[0].env).toEqual({ EXTRA_POSTGRES_SEED_DIR: '../../projects/saga-mesh/seed' });
    expect(res.units.map((u) => u.id)).toEqual(['postgres', 'rabbitmq']);
    expect(res.units.every((u) => u.ok)).toBe(true);
  });

  it('aborts before make up when the preflight finds a conflict', async () => {
    const { runner, calls } = fakeRunner(0);
    const conflictProbe: PortProbe = {
      async dockerHolder(port) {
        return port === 5432 ? 'foreign-pg' : null;
      },
      async listening() {
        return false;
      },
    };
    const res = await meshUp({ soaRoot: SOA, runner, portProbe: conflictProbe });

    expect(res.ok).toBe(false);
    expect(res.makeOk).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0].holder).toBe('foreign-pg');
    expect(calls).toHaveLength(0); // make up never ran
  });

  it('reports makeOk:false (and skips readiness) when make up exits non-zero', async () => {
    const { runner } = fakeRunner(2);
    const { exec, calls } = fakeExec();
    const res = await meshUp({ soaRoot: SOA, runner, exec, portProbe: FREE_PROBE });

    expect(res.makeOk).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.units).toEqual([]);
    expect(calls).toHaveLength(0); // no readiness probes after a failed make up
  });

  it('fails when a gated unit never goes ready (within its timeout)', async () => {
    const { runner } = fakeRunner(0);
    // postgres ready, rabbitmq never — but use a single-attempt timeout via units
    // and a never-ready map.
    const exec: MeshExec = {
      async ready(container) {
        return container !== 'soa-rabbitmq-1';
      },
    };
    const res = await meshUp({
      soaRoot: SOA,
      runner,
      exec,
      portProbe: FREE_PROBE,
      units: ['postgres'],
    });
    // postgres is ready → ok.
    expect(res.ok).toBe(true);

    const res2 = await meshUp({
      soaRoot: SOA,
      runner,
      exec,
      portProbe: FREE_PROBE,
      units: ['rabbitmq'],
      manifest: shortTimeoutManifest(),
      sleep: async () => {},
    });
    expect(res2.ok).toBe(false);
    expect(res2.units[0]).toMatchObject({ id: 'rabbitmq', ok: false });
  });

  it('M7 slot > 0: passes COMPOSE_PROJECT_NAME (arg + env) + offset ports, gates the slot containers', async () => {
    const { runner, calls } = fakeRunner(0);
    const { exec, calls: gated } = fakeExec();
    // The slot's container-name env (set from InstanceProfile.containerEnv) so the
    // readiness resolver + owned-container preflight target soa-s1-*.
    const saved = {
      pg: process.env.SAGA_MESH_POSTGRES_CONTAINER,
      rabbit: process.env.SAGA_MESH_RABBITMQ_CONTAINER,
    };
    process.env.SAGA_MESH_POSTGRES_CONTAINER = 'soa-s1-postgres-1';
    process.env.SAGA_MESH_RABBITMQ_CONTAINER = 'soa-s1-rabbitmq-1';
    try {
      const res = await meshUp({
        soaRoot: SOA,
        runner,
        exec,
        portProbe: FREE_PROBE,
        units: ['postgres', 'rabbitmq'],
        project: 'soa-s1',
        meshOffset: 1000,
      });
      expect(res.ok).toBe(true);
      // COMPOSE_PROJECT_NAME both as a make arg and via child env; ports offset.
      expect(calls[0].args).toContain('COMPOSE_PROJECT_NAME=soa-s1');
      expect(calls[0].args).toContain('POSTGRES_PORT=6432');
      expect(calls[0].env).toEqual({
        EXTRA_POSTGRES_SEED_DIR: '../../projects/saga-mesh/seed',
        COMPOSE_PROJECT_NAME: 'soa-s1',
      });
      // readiness gated the slot's containers, not the base names.
      expect(gated).toEqual(['soa-s1-postgres-1', 'soa-s1-rabbitmq-1']);
    } finally {
      process.env.SAGA_MESH_POSTGRES_CONTAINER = saved.pg;
      process.env.SAGA_MESH_RABBITMQ_CONTAINER = saved.rabbit;
      if (saved.pg === undefined) delete process.env.SAGA_MESH_POSTGRES_CONTAINER;
      if (saved.rabbit === undefined) delete process.env.SAGA_MESH_RABBITMQ_CONTAINER;
    }
  });

  it('M7 slot 0: make env stays byte-identical (no COMPOSE_PROJECT_NAME)', async () => {
    const { runner, calls } = fakeRunner(0);
    const { exec } = fakeExec();
    await meshUp({ soaRoot: SOA, runner, exec, portProbe: FREE_PROBE, units: ['postgres'] });
    expect(calls[0].env).toEqual({ EXTRA_POSTGRES_SEED_DIR: '../../projects/saga-mesh/seed' });
    expect(calls[0].args).not.toContain('COMPOSE_PROJECT_NAME=soa');
  });

  it('honours skipPreflight (caller already ran check_ports)', async () => {
    const { runner, calls } = fakeRunner(0);
    const { exec } = fakeExec();
    // A conflicting probe that should be IGNORED because skipPreflight is set.
    const conflictProbe: PortProbe = {
      async dockerHolder() {
        return 'foreign';
      },
      async listening() {
        return false;
      },
    };
    const res = await meshUp({
      soaRoot: SOA,
      runner,
      exec,
      portProbe: conflictProbe,
      skipPreflight: true,
      units: ['postgres'],
    });
    expect(res.makeOk).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

/** Clone the manifest with rabbitmq's readiness timeout dropped to 1s (fast never-ready test). */
function shortTimeoutManifest(): typeof manifest {
  return {
    ...manifest,
    mesh: {
      ...manifest.mesh,
      rabbitmq: { ...manifest.mesh.rabbitmq, timeoutSec: 1 },
    },
  };
}
