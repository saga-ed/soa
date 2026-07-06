/**
 * 1:1 port of the `want_service` cases in tools/synthetic-dev/test-workspace.sh
 * (the bash "membership predicate" seam), plus the run-set / full-stack edges of
 * the pure `wantService` / `filterWanted` port (core/want-service.ts).
 *
 * The bash test also covers `parse_workspace` (+ its loud-failure guards),
 * `sandbox_env` (lane originate-map vs URL-flip) and the restore map
 * (`restore_dbs_for_service` / `restore_source_for` / `restored_db`). Those pure
 * ports are NOT authored in M0 — they land with the workspace/lane/snapshot
 * verticals (M3/M4). They are recorded here as `it.todo` so the port stays a
 * faithful checklist of test-workspace.sh rather than silently dropping cases.
 */

import { describe, expect, it } from 'vitest';
import type { ServiceId } from '../manifest/index.js';
import { filterWanted, wantService } from '../want-service.js';

describe('wantService — membership gate (port of up.sh want_service)', () => {
  it('classic --only: only the named service is wanted', () => {
    // test-workspace.sh §1: ONLY_SERVICE="programs-api".
    const runSet = new Set<ServiceId>(['programs-api']);
    expect(wantService('programs-api', runSet)).toBe(true);
    expect(wantService('iam-api', runSet)).toBe(false);
  });

  it('workspace run-set: every service in the run-set is wanted, others are not', () => {
    // test-workspace.sh §3: WS_RUN_SET = {programs-api, sis-api}; iam-api is a
    // sandbox dep, NOT in the run-set.
    const runSet = new Set<ServiceId>(['programs-api', 'sis-api']);
    expect(wantService('programs-api', runSet)).toBe(true);
    expect(wantService('sis-api', runSet)).toBe(true);
    expect(wantService('iam-api', runSet)).toBe(false);
  });

  it('empty run-set ⇒ want everything (up.sh empty ONLY_SERVICE = full stack)', () => {
    expect(wantService('iam-api', new Set())).toBe(true);
    expect(wantService('connect-web', [])).toBe(true);
  });

  it('null / undefined run-set ⇒ want everything (full local stack)', () => {
    expect(wantService('iam-api', null)).toBe(true);
    expect(wantService('iam-api', undefined)).toBe(true);
  });

  it('accepts any iterable run-set (array as well as Set)', () => {
    expect(wantService('sis-api', ['programs-api', 'sis-api'])).toBe(true);
    expect(wantService('iam-api', ['programs-api', 'sis-api'])).toBe(false);
  });
});

describe('filterWanted — run-set projection', () => {
  const all: ServiceId[] = ['iam-api', 'programs-api', 'sis-api', 'sessions-api'];

  it('narrows to the run-set, preserving input order', () => {
    expect(filterWanted(all, new Set<ServiceId>(['sis-api', 'programs-api']))).toEqual([
      'programs-api',
      'sis-api',
    ]);
  });

  it('empty / null run-set keeps everything (returns a copy)', () => {
    expect(filterWanted(all, new Set())).toEqual(all);
    expect(filterWanted(all, null)).toEqual(all);
    expect(filterWanted(all, null)).not.toBe(all);
  });
});

// ── test-workspace.sh cases whose pure port is deferred past M0 ───────────────
describe('workspace parse + guards (parseWorkspace) — deferred to the workspace vertical', () => {
  it.todo('parses local-source / sandbox modes + seeds the run-set + IAM_SANDBOX scalar');
  it.todo('guard: local-image mode rejected');
  it.todo('guard: sandbox mode without a sandboxName rejected');
  it.todo('guard: invalid/empty mode rejected; empty services rejected');
  it.todo('guard: non-iam sandbox is recorded but warns (dep-repoint is iam-only)');
});

describe('lane env (sandboxEnv) — originate-map vs URL-flip — deferred', () => {
  it.todo('sis-api originates the iam preview header + flips IAM_BASEURL/IAM_TOKENURL');
  it.todo('programs-api originates + flips IAM_API_URL');
  it.todo('scheduling-api / sessions-api do NOT originate → URL flip only');
});

describe('restore map (restoreDbsForService / restoreSourceFor / restoredDb) — deferred', () => {
  it.todo('iam-api maps to TWO DBs (iam_local + iam_pii_local)');
  it.todo('single-DB services map 1:1; sis-api / scheduling map to no snapshot source');
  // The iam two-DB "skip seed only when BOTH restored" rule IS exercised at the
  // service granularity in compose-seed-plan.unit.test.ts (gate 2); the DB-level
  // restoredDb predicate that decides service ∈ restored lands with the snapshot layer.
  it.todo('restoredDb: iam-api skipped only when BOTH iam DBs restored (partial ⇒ still seed)');
});
