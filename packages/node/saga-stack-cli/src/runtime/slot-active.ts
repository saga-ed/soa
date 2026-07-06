/**
 * Slot-activity probe (M13-A `ss set list` ACTIVE column, plan §2.4).
 *
 * A slot is ACTIVE iff its state dir holds a live service pid (the launcher
 * writes `<stateDir>/<id>.pid` per spawned service) OR its compose project
 * (`soa` / `soa-s<N>`) has running containers. DERIVED LIVE on every call —
 * there is deliberately NO recorded active.json (nothing to go stale; skelly's
 * OQ2 call, plan §9.2).
 *
 * Both legs fold errors to `false`: a missing state dir, an unreadable pid
 * file, or an absent/unreachable docker CLI must degrade to "not active", never
 * abort a read-only `set list`.
 */

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The injectable probe: one question, derived live. */
export interface SlotActiveProbe {
  /** True iff the slot with this state dir / compose project shows life. */
  isActive(stateDir: string, project: string): Promise<boolean>;
}

/** Injectable deps so unit tests drive both legs without fs/docker/processes. */
export interface SlotActiveDeps {
  /** `*.pid` file names under the state dir (`[]` when the dir is missing). */
  listPidFiles?: (stateDir: string) => string[];
  /** The pid a pid file holds, or `null` on any read/parse failure. */
  readPid?: (path: string) => number | null;
  /** Liveness: signal-0 the pid (EPERM counts as alive). */
  pidAlive?: (pid: number) => boolean;
  /** True iff the compose project has running containers. */
  projectHasContainers?: (project: string) => Promise<boolean>;
}

function defaultListPidFiles(stateDir: string): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.endsWith('.pid'))
      .map((f) => join(stateDir, f));
  } catch {
    return [];
  }
}

function defaultReadPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultProjectHasContainers(project: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      { timeout: 5000 },
      (err, stdout) => resolve(!err && stdout.trim() !== ''),
    );
  });
}

/** Build the probe; production passes no deps. */
export function makeSlotActiveProbe(deps: SlotActiveDeps = {}): SlotActiveProbe {
  const listPidFiles = deps.listPidFiles ?? defaultListPidFiles;
  const readPid = deps.readPid ?? defaultReadPid;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const projectHasContainers = deps.projectHasContainers ?? defaultProjectHasContainers;

  return {
    async isActive(stateDir: string, project: string): Promise<boolean> {
      for (const file of listPidFiles(stateDir)) {
        const pid = readPid(file);
        if (pid !== null && pidAlive(pid)) return true;
      }
      return projectHasContainers(project);
    },
  };
}
