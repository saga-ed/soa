/**
 * Native status / verify integration tests (plan §2.4, §7.2 "M2").
 *
 * `stack status` and `stack verify` no longer shell out — they probe a
 * manifest-derived endpoint list through the injectable HealthProber. These
 * tests REPLACE that prober (via `BaseCommand.prototype.getProber`) with a fake
 * that records the probed URLs and returns canned up/down results, so the native
 * gate logic is asserted WITHOUT any real HTTP or a running stack. The `--full`
 * delegation path additionally replaces the Runner (the same seam the M1 wrap
 * tests use) to assert verify.sh is invoked rather than probed.
 *
 * Path resolution is deterministic (--soa <real soa> + --dev <fixed>) so the
 * delegated verify.sh path resolves to the real (READ-ONLY, never run) script.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import { computeClosure } from '../../../core/closure.js';
import { deriveInstance } from '../../../core/derive-instance.js';
import { manifest } from '../../../core/manifest/index.js';
import type { HealthProber, ProbeResult } from '../../../runtime/health.js';
import type {
  ForeignProcs,
  GhRunner,
  GitRunner,
  MeshExec,
  OverlayFs,
  PgProbe,
  RunResult,
  ScriptInvocation,
  SlotActiveProbe,
} from '../../../runtime/index.js';
import type { ForeignProc } from '../../../core/foreign-procs.js';
import StackStatus from '../status.js';
import StackVerify from '../verify.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

const CONTENT_URL = 'http://localhost:3009/health';
const DASH_URL = 'http://localhost:8900/';
const SIS_URL = 'http://localhost:3100/health';

let config: Config;
let probed: string[];
let runnerCalls: ScriptInvocation[];
let out: string[];

/** Fake prober: record every probed URL; any URL in `downUrls` answers down. */
function installProber(downUrls: string[] = []): void {
  probed = [];
  const down = new Set(downUrls);
  const fake: HealthProber = {
    async probe(url: string): Promise<ProbeResult> {
      probed.push(url);
      return down.has(url) ? { ok: false } : { ok: true, status: 200 };
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getProber: () => HealthProber },
    'getProber',
  ).mockReturnValue(fake);
}

/**
 * Fake the foreign-process seam. `find` returns the canned findings; `reap` is
 * never expected on the verify path (warn-only). Defaults to none, so the real
 * lsof/ss/ps never run in a unit test.
 */
function installForeign(findings: ForeignProc[] = []): void {
  const fake: ForeignProcs = {
    async find() {
      return findings;
    },
    async reap(f) {
      return f.map((x) => ({ ...x, killed: true }));
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getForeignProcs: () => ForeignProcs },
    'getForeignProcs',
  ).mockReturnValue(fake);
}

/** Fake Runner for the --full delegation path; records the invocation. */
function installRunner(code = 0): void {
  runnerCalls = [];
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRunner: () => unknown },
    'getRunner',
  ).mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runnerCalls.push(spec);
      return { code };
    },
  });
}

/**
 * Fake pg-scalar + mesh-readiness seams for the native `--full` DATA checks (M9).
 * Defaults to a fully-green stack (205 users, dev id, 6 admin personas, sis migrated,
 * mongo up); overrides flip individual readings to drive the hard-fail paths.
 */
function installDataProbes(over: { users?: string; devId?: string; admin?: string; sisMigrated?: boolean; mongoReachable?: boolean } = {}): void {
  const pg: PgProbe = {
    async databaseExists(): Promise<boolean> { return true; },
    async hasMigrationsTable(): Promise<boolean> { return over.sisMigrated ?? true; },
    async publicTableCount(): Promise<number> { return 0; },
    async scalar(_c, _db, sql): Promise<string> {
      if (sql.includes('FROM users WHERE')) return over.devId ?? '1';
      if (sql.includes('FROM users')) return over.users ?? '205';
      if (sql.includes('personas')) return over.admin ?? '6';
      return '';
    },
  };
  const mesh: MeshExec = { async ready(): Promise<boolean> { return over.mongoReachable ?? true; } };
  const proto = BaseCommand.prototype as unknown as {
    getPgProbe: () => PgProbe;
    getMeshExec: () => MeshExec;
  };
  vi.spyOn(proto, 'getPgProbe').mockReturnValue(pg);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(mesh);
}

/**
 * Fake git + gh + overlay-fs seams for the M12 NATIVE source-posture pass. Defaults to a
 * clean posture (no overlay file, every repo on `main`, fetch ok, 0 behind) ⇒ zero
 * warnings; `over` flips the readings to drive drift (wrong branch / behind / unmerged
 * pin / unpinned overlay) so the warn-only invariant can be asserted.
 */
function installPostureSeams(over: {
  overlay?: string | null; // tsv text, or null (no overlay file — the default)
  branch?: string; // branchShowCurrent for every repo (default 'main')
  behind?: number | null; // countBehindRef for every repo (default 0)
  isAncestor?: boolean; // mergeBaseIsAncestor (P2 pin merged; default true)
  oid?: string; // prHeadOid (P2; default 'abc' — a resolvable head)
  mergeSubjects?: string; // logMergeSubjects (P3; default '' — no overlays)
  fetchOk?: boolean; // fetch (P4; default true)
  diffQuiet?: boolean; // diffQuiet origin/main HEAD (P1 ≡main gate; default true)
} = {}): void {
  const git: Partial<GitRunner> = {
    async branchShowCurrent(): Promise<string> { return over.branch ?? 'main'; },
    async fetch(): Promise<boolean> { return over.fetchOk ?? true; },
    async countBehindRef(): Promise<number | null> { return over.behind ?? 0; },
    async diffQuiet(): Promise<boolean> { return over.diffQuiet ?? true; },
    async mergeBaseIsAncestor(): Promise<boolean> { return over.isAncestor ?? true; },
    async logMergeSubjects(): Promise<string> { return over.mergeSubjects ?? ''; },
    async statusPorcelain(): Promise<string> { return ''; },
  };
  const gh: Partial<GhRunner> = {
    async prHeadRef(): Promise<string> { return 'feat/x'; },
    async prHeadOid(): Promise<string> { return over.oid ?? 'abc'; },
    async prNumberForHead(): Promise<string> { return ''; },
  };
  const overlayFs: OverlayFs = { readManifest: () => over.overlay ?? null };
  const proto = BaseCommand.prototype as unknown as {
    getGitRunner: () => GitRunner;
    getGhRunner: () => GhRunner;
    getOverlayFs: () => OverlayFs;
  };
  vi.spyOn(proto, 'getGitRunner').mockReturnValue(git as GitRunner);
  vi.spyOn(proto, 'getGhRunner').mockReturnValue(gh as GhRunner);
  vi.spyOn(proto, 'getOverlayFs').mockReturnValue(overlayFs);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  installProber();
  installRunner(0);
  installForeign(); // default: no foreign processes (real lsof/ps never runs in tests)
  // The fake workspace paths (--dev /fixed/dev) don't exist on disk; default the
  // repo-dir check to "present" so every service is probed. The not-cloned path is
  // covered explicitly below.
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
    'getRepoDirCheck',
  ).mockReturnValue(() => true);
  out = [];
  // Capture (and suppress) the commands' emitted lines. oclif's `this.log` does
  // not route through process.stdout.write, so we spy the inherited `log` on the
  // shared BaseCommand prototype — every command instance resolves to it.
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack status — native, manifest-derived, read-only', () => {
  it('probes every non-optional service INCLUDING content-api :3009 (the closed gap)', async () => {
    await StackStatus.run([...WS], config);
    expect(probed).toContain(CONTENT_URL);
    expect(probed).toHaveLength(13); // 10 core + rtsm-api + coach-api/coach-web; no playback
  });

  it('--only scopes the probes to the dependency closure', async () => {
    await StackStatus.run(['--only', 'connect-web', ...WS], config);
    const expected = computeClosure(manifest, ['connect-web']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).toContain('http://localhost:6210/'); // connect-web itself
    expect(probed).toContain(CONTENT_URL); // pulled in via connect-api
  });

  it('--with coach scopes the probes to the coach bundle closure (sugar over --only)', async () => {
    await StackStatus.run(['--with', 'coach', ...WS], config);
    const expected = computeClosure(manifest, ['coach-api', 'coach-web']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).toContain('http://localhost:6105/health'); // coach-api
    expect(probed).not.toContain(DASH_URL); // saga-dash outside the coach closure
  });

  it('--with playback scopes to the 3 playback services (not the whole stack)', async () => {
    await StackStatus.run(['--with', 'playback', ...WS], config);
    const expected = computeClosure(manifest, ['transcripts-api', 'insights-api', 'chat-api'], {
      withPlayback: true,
    }).services.map((id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`);
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).not.toContain(CONTENT_URL); // narrowed, not full-stack
  });

  it('--with qtf is seed-only ⇒ no service scope ⇒ probes the full non-optional stack', async () => {
    await StackStatus.run(['--with', 'qtf', ...WS], config);
    expect(probed).toHaveLength(13);
  });

  it('NEVER exits non-zero even when services are down (read-only)', async () => {
    installProber([CONTENT_URL, DASH_URL]);
    await expect(StackStatus.run([...WS, '--output-json'], config)).resolves.toBeUndefined();
    const json = JSON.parse(out.join(''));
    expect(json.healthy).toBe(false);
    expect(json.summary).toMatchObject({ total: 13, down: 2 });
  });

  it('porcelain emits one key=value per service plus healthy=', async () => {
    await StackStatus.run([...WS, '--porcelain'], config);
    const text = out.join('\n');
    expect(text).toContain('content-api=up');
    expect(text).toContain('healthy=true');
  });
});

describe('stack verify — native health gate', () => {
  it('PASS (no throw, no exit) when every required service is up', async () => {
    await expect(StackVerify.run([...WS], config)).resolves.toBeUndefined();
    expect(probed).toContain(CONTENT_URL); // gap-closing endpoint is gated
  });

  it('FAIL → exit 1 when a required service is down', async () => {
    installProber([CONTENT_URL]);
    await expect(StackVerify.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
  });

  it('--tolerate <service-id>: a tolerated down service does NOT fail the gate', async () => {
    installProber([CONTENT_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'content-api', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('--tolerate <repo>: tolerates ALL services of that repo (sis-api via "rostering")', async () => {
    installProber([SIS_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'rostering', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('a NON-tolerated down service still fails even when another is tolerated', async () => {
    installProber([CONTENT_URL, DASH_URL]);
    await expect(
      StackVerify.run(['--tolerate', 'content-api', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });
  });

  it('--only scopes the gate to the closure (so a partial stack does not fail on unstarted services)', async () => {
    await StackVerify.run(['--only', 'scheduling-api,sessions-api', ...WS], config);
    const expected = computeClosure(manifest, ['scheduling-api', 'sessions-api']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).not.toContain(DASH_URL); // saga-dash not in the closure → not probed
    expect(probed).not.toContain(CONTENT_URL); // content-api not in the closure → not probed
  });

  it('--only: a service OUTSIDE the closure being down does NOT fail the gate', async () => {
    installProber([DASH_URL, CONTENT_URL]); // both outside the scheduling/sessions closure
    await expect(
      StackVerify.run(['--only', 'scheduling-api,sessions-api', ...WS], config),
    ).resolves.toBeUndefined();
  });

  it('--with coach scopes the gate to the coach bundle closure (sugar over --only)', async () => {
    await StackVerify.run(['--with', 'coach', ...WS], config);
    const expected = computeClosure(manifest, ['coach-api', 'coach-web']).services.map(
      (id) => `${manifest.services[id].lane.stack}${manifest.services[id].healthPath}`,
    );
    expect(new Set(probed)).toEqual(new Set(expected));
    expect(probed).not.toContain(DASH_URL); // saga-dash outside the coach closure → not gated
  });

  it('--with coach: a service outside the bundle closure being down does NOT fail', async () => {
    installProber([DASH_URL, CONTENT_URL]); // both outside the coach closure
    await expect(StackVerify.run(['--with', 'coach', ...WS], config)).resolves.toBeUndefined();
  });
});

describe('stack verify — FOREIGN process flag (warn-only, never flips the gate)', () => {
  const FOREIGN_IAM: ForeignProc = {
    id: 'iam-api',
    port: 3010,
    pid: 3537029,
    pgid: 576078,
    command: 'node dist/main.js',
  };

  it('all services up + a foreign holder → still PASSES, with a ⚠ FOREIGN line', async () => {
    installForeign([FOREIGN_IAM]); // iam-api :3010 held by a non-ss process
    await expect(StackVerify.run([...WS], config)).resolves.toBeUndefined(); // warn-only ⇒ no exit(1)
    const text = out.join('\n');
    expect(text).toContain('FOREIGN');
    expect(text).toContain('iam-api');
    expect(text).toContain('cold-start'); // the remediation hint
  });

  it('porcelain emits `<id>=foreign` and keeps passed=true', async () => {
    installForeign([FOREIGN_IAM]);
    await StackVerify.run(['--porcelain', ...WS], config);
    const lines = out.join('\n');
    expect(lines).toContain('iam-api=foreign');
    expect(lines).toContain('passed=true');
  });

  it('--output-json carries the foreign list + count', async () => {
    installForeign([FOREIGN_IAM]);
    await expect(StackVerify.run(['--output-json', ...WS], config)).resolves.toBeUndefined();
    const json = JSON.parse(out.join(''));
    expect(json.passed).toBe(true);
    expect(json.summary.foreign).toBe(1);
    expect(json.foreign).toEqual([
      { id: 'iam-api', port: 3010, pid: 3537029, command: 'node dist/main.js' },
    ]);
  });

  it('a DOWN service still fails the gate even though a foreign flag is warn-only', async () => {
    installProber([SIS_URL]); // sis genuinely down
    installForeign([FOREIGN_IAM]); // foreign flag present but must not change the verdict
    await expect(StackVerify.run([...WS], config)).rejects.toMatchObject({ oclif: { exit: 1 } });
  });
});

describe('status / verify — a service whose repo is not cloned is not-cloned, not down', () => {
  const COACH_API_URL = 'http://localhost:6105/health';
  const COACH_WEB_URL = 'http://localhost:8800/';

  /** Report the coach checkout (dir ending in `/coach`) as absent; everything else present. */
  function markCoachAbsent(): void {
    vi.spyOn(
      BaseCommand.prototype as unknown as { getRepoDirCheck: () => (dir: string) => boolean },
      'getRepoDirCheck',
    ).mockReturnValue((dir: string) => !dir.endsWith('/coach'));
  }

  it('verify PASSES with coach absent (coach reported not-cloned, not a failure)', async () => {
    markCoachAbsent();
    // Every probed service answers up; the ONLY down-ish services would be coach,
    // which must be excluded from the gate entirely.
    await expect(StackVerify.run([...WS], config)).resolves.toBeUndefined();
    // coach-api / coach-web were never probed …
    expect(probed).not.toContain(COACH_API_URL);
    expect(probed).not.toContain(COACH_WEB_URL);
    // … and the other non-optional services still were.
    expect(probed).toContain(CONTENT_URL);
  });

  it('verify still PASSES with coach absent even when coach WOULD answer down', async () => {
    markCoachAbsent();
    installProber([COACH_API_URL, COACH_WEB_URL]); // moot — coach is never probed
    await expect(StackVerify.run(['--output-json', ...WS], config)).resolves.toBeUndefined();
    const json = JSON.parse(out.join(''));
    expect(json.passed).toBe(true);
    expect(json.notCloned.map((n: { id: string }) => n.id).sort()).toEqual(['coach-api', 'coach-web']);
    expect(json.summary.notCloned).toBe(2);
  });

  it('status reports coach not-cloned (excluded from the healthy verdict)', async () => {
    markCoachAbsent();
    await StackStatus.run(['--output-json', ...WS], config);
    const json = JSON.parse(out.join(''));
    expect(json.healthy).toBe(true);
    expect(json.notCloned.map((n: { id: string }) => n.id).sort()).toEqual(['coach-api', 'coach-web']);
    expect(json.services.some((s: { id: string }) => s.id === 'coach-api')).toBe(false);
  });
});

describe('stack verify --full — FULLY NATIVE: health + DATA + posture, NOTHING delegated (M12)', () => {
  it('runs the native health gate + native DATA + native posture, delegating NOTHING to verify.sh', async () => {
    installDataProbes(); // fully-green stack
    installPostureSeams(); // clean posture, no overlay
    await StackVerify.run(['--full', ...WS], config);
    // native health ran (NOT delegation) — the probe seam was exercised.
    expect(probed.length).toBeGreaterThan(0);
    // M12: the posture pass is NATIVE — verify.sh is NEVER invoked under --full.
    expect(runnerCalls).toHaveLength(0);
    // the native posture section is rendered.
    expect(out.some((l) => l.includes('── source posture ──'))).toBe(true);
    expect(out.some((l) => l.includes('── freshness (behind origin) ──'))).toBe(true);
  });

  it('--full --health-only skips the posture/freshness pass (health + DATA only, still nothing delegated)', async () => {
    installDataProbes();
    installPostureSeams();
    await StackVerify.run(['--full', '--health-only', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    expect(out.some((l) => l.includes('── source posture ──'))).toBe(false);
    expect(out.some((l) => l.includes('── data ──'))).toBe(true);
  });

  it('HARD-FAILS (exit 1) on a native DATA gap (D5 mongo unreachable)', async () => {
    installDataProbes({ mongoReachable: false });
    installPostureSeams();
    await expect(StackVerify.run(['--full', ...WS], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
  });

  // ── THE OVERRIDING INVARIANT: P1–P4 are STRICTLY WARN-ONLY. ──
  it('P1–P4 ALL "failing" (wrong branch + behind origin) do NOT flip the verdict — verify still exits 0 when health+DATA pass', async () => {
    installDataProbes(); // health + DATA green
    // every repo parked on local/integration that does NOT ≡ main (P1 drift) AND behind
    // origin (P4). local/integration is a freshness candidate, so BOTH warns fire at once.
    installPostureSeams({ branch: 'local/integration', diffQuiet: false, behind: 7 });
    // NO throw ⇒ exit 0. Posture drift is surfaced as warnings but never fails the gate.
    await expect(StackVerify.run(['--full', ...WS], config)).resolves.toBeUndefined();
    // the drift really was detected (warnings printed) — proving it's warn-only, not skipped.
    expect(out.some((l) => l.startsWith('⚠') && l.includes('posture drift'))).toBe(true);
    expect(out.some((l) => l.startsWith('⚠') && l.includes('behind origin/main'))).toBe(true);
    // and the final verdict is a PASS that merely annotates the warning count.
    expect(out.some((l) => l.includes('✓ verify --full: health + data green') && l.includes('posture warning'))).toBe(true);
  });

});

describe('stack verify --slot N — backend + saga-dash/coach gate on offset ports (M7 Phase 2)', () => {
  // No NON-optional service is excluded at slot>0 anymore (soa#271): connect-api AND
  // connect-web are slottable (sessions dial tokenized; shared slot-0 livekit + per-slot
  // rtsm fleet), as are saga-dash/coach-web (offset --port) and ads-adm-api. Only the
  // literal-port playback trio stays excluded, and it's optional (pulled by --with
  // playback), so it's not in the default probe set at all.
  it('slot > 0 gates every non-optional service — backends + connect-api/connect-web + saga-dash/coach — on offset ports', async () => {
    await StackVerify.run(['--slot', '1', ...WS], config);
    const profile = deriveInstance({ slot: 1 });

    // the backend services ARE probed, on the +1000 offset port.
    const iamUrl = `http://localhost:${profile.portOverrides['iam-api']}${manifest.services['iam-api'].healthPath}`;
    expect(probed).toContain(iamUrl);
    expect(iamUrl).toContain(`:${manifest.services['iam-api'].port + 1000}`);

    // every frontend + slottable backend is gated now on its offset port —
    // saga-dash/coach-web/connect-web frontends + ads-adm-api + connect-api.
    for (const id of ['saga-dash', 'coach-web', 'connect-web', 'ads-adm-api', 'connect-api'] as const) {
      const url = `http://localhost:${profile.portOverrides[id]}${manifest.services[id].healthPath}`;
      expect(probed).toContain(url);
      expect(url).toContain(`:${manifest.services[id].port + 1000}`);
    }

    // the full non-optional set is slottable now: all 13 are probed.
    expect(probed).toHaveLength(13);
  });

  it('slot 0 verify is byte-identical: probes every non-optional service on base ports', async () => {
    await StackVerify.run([...WS], config);
    expect(probed).toContain(DASH_URL); // frontends gated at slot 0
    expect(probed).toHaveLength(13);
  });
});

/** Fake SlotActiveProbe: a slot is active iff its number is in `activeSlots`. */
function installSlotActive(activeSlots: number[]): void {
  const active = new Set(activeSlots);
  const probe: SlotActiveProbe = {
    async isActive(_stateDir: string, project: string): Promise<boolean> {
      const slot = project === 'soa' ? 0 : Number.parseInt(project.replace('soa-s', ''), 10);
      return active.has(slot);
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getSlotActiveProbe: () => SlotActiveProbe },
    'getSlotActiveProbe',
  ).mockReturnValue(probe);
}

/** Fully-green DATA probes that RECORD the postgres container each read hit (to assert
 *  per-slot mesh selection). Returns the captured container-name list. */
function installCapturingDataProbes(): { pgContainers: string[] } {
  const pgContainers: string[] = [];
  const pg: PgProbe = {
    async databaseExists(): Promise<boolean> { return true; },
    async hasMigrationsTable(c): Promise<boolean> { pgContainers.push(c); return true; },
    async publicTableCount(): Promise<number> { return 0; },
    async scalar(c, _db, sql): Promise<string> {
      pgContainers.push(c);
      if (sql.includes('FROM users WHERE')) return '1';
      if (sql.includes('FROM users')) return '205';
      if (sql.includes('personas')) return '6';
      return '';
    },
  };
  const mesh: MeshExec = { async ready(): Promise<boolean> { return true; } };
  const proto = BaseCommand.prototype as unknown as {
    getPgProbe: () => PgProbe;
    getMeshExec: () => MeshExec;
  };
  vi.spyOn(proto, 'getPgProbe').mockReturnValue(pg);
  vi.spyOn(proto, 'getMeshExec').mockReturnValue(mesh);
  return { pgContainers };
}

describe('stack verify --all-slots — report every ACTIVE slot (0..9)', () => {
  it('no active slots ⇒ resolves (exit 0) with a "no active slots" note, probing nothing', async () => {
    installSlotActive([]);
    await expect(StackVerify.run(['--all-slots', ...WS], config)).resolves.toBeUndefined();
    expect(probed).toHaveLength(0);
    expect(out.some((l) => l.includes('no active slots'))).toBe(true);
  });

  it('health-only: renders a section per active slot on that slot’s offset ports (slots 0 + 2)', async () => {
    installSlotActive([0, 2]);
    await StackVerify.run(['--all-slots', ...WS], config);
    const s2 = deriveInstance({ slot: 2 });
    const iam2 = `http://localhost:${s2.portOverrides['iam-api']}${manifest.services['iam-api'].healthPath}`;
    // slot 0's base iam + slot 2's +2000 iam were both probed.
    expect(probed).toContain(`http://localhost:${manifest.services['iam-api'].port}${manifest.services['iam-api'].healthPath}`);
    expect(probed).toContain(iam2);
    // one section header per active slot; slots 1 + 3..9 are inactive ⇒ absent.
    expect(out.some((l) => l.includes('── slot 0 (soa)'))).toBe(true);
    expect(out.some((l) => l.includes('── slot 2 (soa-s2)'))).toBe(true);
    expect(out.some((l) => l.includes('── slot 1'))).toBe(false);
    expect(out.some((l) => l.includes('✓ verify --all-slots: 2/2 active slot(s) green'))).toBe(true);
  });

  it('--full: each active slot reads DATA against ITS OWN soa-s<N> mesh, posture runs ONCE', async () => {
    installSlotActive([0, 2]);
    const { pgContainers } = installCapturingDataProbes();
    installPostureSeams(); // clean, no overlay
    const priorEnv = process.env.SAGA_MESH_POSTGRES_CONTAINER;
    await StackVerify.run(['--full', '--all-slots', ...WS], config);
    // slot 2's DATA read hit the soa-s2 postgres; slot 0's hit the base container.
    expect(pgContainers).toContain('soa-s2-postgres-1');
    expect(pgContainers).toContain('soa-postgres-1');
    // the per-slot env scoping is fully restored afterwards (no leak).
    expect(process.env.SAGA_MESH_POSTGRES_CONTAINER).toBe(priorEnv);
    // source posture rendered EXACTLY once (shared checkouts), not per slot.
    expect(out.filter((l) => l.includes('── source posture')).length).toBe(1);
    expect(runnerCalls).toHaveLength(0); // still nothing delegated to verify.sh
  });

  it('HARD-FAILS (exit 1) naming the failing slot when a service is down in one slot', async () => {
    installSlotActive([0, 2]);
    // take slot 2's iam-api down (its +2000 port); slot 0 stays green.
    const s2 = deriveInstance({ slot: 2 });
    const iam2 = `http://localhost:${s2.portOverrides['iam-api']}${manifest.services['iam-api'].healthPath}`;
    installProber([iam2]); // independent of the slot-active spy above
    await expect(StackVerify.run(['--all-slots', ...WS], config)).rejects.toMatchObject({
      oclif: { exit: 1 },
    });
    expect(out.some((l) => l.includes('1/2 active slot(s) failing') && l.includes('slot(s) 2'))).toBe(true);
  });

  it('--all-slots with an explicit --slot N>0 is a hard error (mutually exclusive targeting)', async () => {
    installSlotActive([0]);
    await expect(StackVerify.run(['--all-slots', '--slot', '3', ...WS], config)).rejects.toMatchObject({
      oclif: { exit: 2 },
    });
  });

  it('--output-json emits a per-slot array with activeSlots + a combined verdict', async () => {
    installSlotActive([0, 2]);
    await StackVerify.run(['--all-slots', '--output-json', ...WS], config);
    const json = JSON.parse(out.join('\n'));
    expect(json.activeSlots).toEqual([0, 2]);
    expect(json.slots.map((s: { slot: number }) => s.slot)).toEqual([0, 2]);
    expect(json.passed).toBe(true);
  });
});
