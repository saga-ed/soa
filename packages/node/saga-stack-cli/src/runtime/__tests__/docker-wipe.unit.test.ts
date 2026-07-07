/**
 * docker-wipe unit tests (cold-start).
 *
 * The load-bearing logic is the two PURE argv builders — assert they mirror the infra Makefile's
 * `COMPOSE` var (env-file + compose file + explicit project) plus the `-v`/`--remove-orphans` the
 * clean slate needs, and that the host-global prune is the fully-forced form.
 */

import { describe, expect, it } from 'vitest';
import {
  MESH_COMPOSE_ENV_FILE,
  MESH_COMPOSE_FILE,
  composeDownVArgs,
  systemPruneArgs,
} from '../docker-wipe.js';

describe('composeDownVArgs — mirrors infra COMPOSE + volume wipe', () => {
  it('passes the env-file, mesh compose file, explicit project, and down -v --remove-orphans', () => {
    expect(composeDownVArgs('soa')).toEqual([
      'compose',
      '--env-file',
      MESH_COMPOSE_ENV_FILE,
      '-f',
      MESH_COMPOSE_FILE,
      '-p',
      'soa',
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
  });

  it('threads a slot project name through -p (so a slot wipe targets its own mesh)', () => {
    const args = composeDownVArgs('soa-s3');
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('soa-s3');
    // never a bare `down` without the volume + orphan flags — that would leak the DB data.
    expect(args).toContain('--volumes');
    expect(args).toContain('--remove-orphans');
  });
});

describe('systemPruneArgs — the host-global nuke', () => {
  it('is the fully-forced all+volumes prune', () => {
    expect(systemPruneArgs()).toEqual(['system', 'prune', '--all', '--force', '--volumes']);
  });
});
