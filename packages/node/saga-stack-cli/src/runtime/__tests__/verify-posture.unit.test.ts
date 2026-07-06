/**
 * verify-posture ORCHESTRATOR unit tests (M12; verify.sh P1–P4 pass).
 *
 * Drive `assessPosture` with a FAKE `GitRunner` + `GhRunner` + `.git` existence predicate
 * — no real git/gh/network/fs. Assert the byte-faithful behaviour of each check AND the
 * overriding invariant: every produced line is warn-only (there is no failure path), a
 * gh-offline P2 / a fetch-failed P4 degrade to a warn WITHOUT throwing, and the P3
 * set-subtraction surfaces exactly the unpinned overlays.
 */

import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../git.js';
import type { GhRunner } from '../gh.js';
import { assessPosture } from '../verify-posture.js';

/** Per-repo (keyed by path) scriptable git/gh state. Every field defaults to a clean repo. */
interface RepoScript {
  branch?: string; // branchShowCurrent (default 'main')
  behind?: number | null; // countBehindRef origin/main (default 0)
  fetchOk?: boolean; // fetch (default true)
  diffQuiet?: boolean; // diff --quiet origin/main HEAD (default true)
  mergeSubjects?: string; // log --merges (default '')
  ancestors?: string[]; // oids that ARE ancestors of HEAD (default: all)
  headOidByPr?: Record<string, string>; // prHeadOid: pr# → oid ('' ⇒ gh couldn't resolve)
  headRefByPr?: Record<string, string>; // prHeadRef: pr# → branch
  prNumByBranch?: Record<string, string>; // prNumberForHead: branch → #
  missing?: boolean; // .git absent
}

/** `/dev/<name>` is the resolved path for repo <name> in these tests. */
const P = (name: string): string => `/dev/${name}`;

function fakes(byName: Record<string, RepoScript> = {}): {
  git: GitRunner;
  gh: GhRunner;
  pathExists: (p: string) => boolean;
} {
  const s = (path: string): RepoScript => byName[path.replace('/dev/', '')] ?? {};
  const git = {
    async branchShowCurrent(p: string) { return s(p).branch ?? 'main'; },
    async fetch(p: string) { return s(p).fetchOk ?? true; },
    async countBehindRef(p: string) { return s(p).behind ?? 0; },
    async diffQuiet(p: string) { return s(p).diffQuiet ?? true; },
    async logMergeSubjects(p: string) { return s(p).mergeSubjects ?? ''; },
    async mergeBaseIsAncestor(p: string, ancestor: string) {
      const a = s(p).ancestors;
      return a ? a.includes(ancestor) : true;
    },
    // unused-by-posture verbs (present so the object satisfies GitRunner)
    async statusPorcelain() { return ''; },
    async symbolicRefDefault() { return 'main'; },
    async hasUpstream() { return true; },
    async revListCount() { return 0; },
    async mergeFfOnly() { return true; },
    async revParseVerify() { return true; },
    async checkoutB() { return true; },
    async merge() { return true; },
    async mergeAbort() { return true; },
    async branchDelete() { return true; },
    async checkout() { return true; },
    async clone() { return true; },
  } as unknown as GitRunner;
  const gh = {
    async prHeadOid(pr: string, cwd: string) { return s(cwd).headOidByPr?.[pr] ?? 'oid-' + pr; },
    async prHeadRef(pr: string, cwd: string) { return s(cwd).headRefByPr?.[pr] ?? ''; },
    async prNumberForHead(branch: string, cwd: string) { return s(cwd).prNumByBranch?.[branch] ?? ''; },
  } as unknown as GhRunner;
  const pathExists = (p: string): boolean => {
    // p is `<path>/.git`; strip the suffix back to the repo path.
    const repoPath = p.replace(/\/\.git$/, '');
    return !s(repoPath).missing;
  };
  return { git, gh, pathExists };
}

/** Assert no line in a list is anything but warn/ok/note (the structural invariant). */
function warnOnly(lines: { level: string }[]): void {
  for (const l of lines) expect(['ok', 'warn', 'note']).toContain(l.level);
}

describe('assessPosture — clean default stack (no overlay)', () => {
  it('every managed + always-main repo on main ⇒ all ok, zero warnings', async () => {
    const { git, gh, pathExists } = fakes();
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    expect(r.posture.every((l) => l.level === 'ok')).toBe(true);
    expect(r.freshness.every((l) => l.level === 'ok')).toBe(true);
    // 5 managed + 2 always-main = 7 posture lines; freshness covers the same 7.
    expect(r.posture).toHaveLength(7);
    expect(r.freshness).toHaveLength(7);
    warnOnly([...r.posture, ...r.freshness]);
  });
});

describe('P1 — branch posture', () => {
  it('an un-pinned managed repo on the WRONG branch ⇒ posture-drift WARN (no fail)', async () => {
    const { git, gh, pathExists } = fakes({ 'saga-dash': { branch: 'feature/x' } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    const dash = r.posture.find((l) => l.message.includes('saga-dash'));
    expect(dash?.level).toBe('warn');
    expect(dash?.message).toContain('posture drift');
    warnOnly(r.posture);
  });

  it('an always-main repo (soa) parked on local/integration ⇒ STRICT drift WARN (no ≡main grace)', async () => {
    const { git, gh, pathExists } = fakes({ soa: { branch: 'local/integration', diffQuiet: true } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    const soa = r.posture.find((l) => l.message.startsWith('soa') || l.message.includes('soa '));
    expect(soa?.level).toBe('warn');
  });
});

describe('P2 — pin merged', () => {
  const pins = new Map([['saga-dash', '410']]);

  it('pinned repo on local/integration with the pin merged ⇒ branch ok + "#410 merged in"', async () => {
    const { git, gh, pathExists } = fakes({
      'saga-dash': { branch: 'local/integration', headOidByPr: { '410': 'sha410' }, ancestors: ['sha410'] },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    expect(r.posture.some((l) => l.level === 'ok' && l.message.includes('#410 merged in'))).toBe(true);
    warnOnly(r.posture);
  });

  it('pin present but NOT merged ⇒ WARN "NOT in checkout" (no fail)', async () => {
    const { git, gh, pathExists } = fakes({
      'saga-dash': { branch: 'local/integration', headOidByPr: { '410': 'sha410' }, ancestors: [] },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    expect(r.posture.some((l) => l.level === 'warn' && l.message.includes('NOT in checkout'))).toBe(true);
  });

  it('gh offline (headOid "") ⇒ "couldn\'t check" WARN, no throw', async () => {
    const { git, gh, pathExists } = fakes({
      'saga-dash': { branch: 'local/integration', headOidByPr: { '410': '' } },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    expect(r.posture.some((l) => l.level === 'warn' && l.message.includes('couldn'))).toBe(true);
  });

  it('pinned repo NOT on local/integration ⇒ only the branch drift warn, pin checks skipped', async () => {
    const { git, gh, pathExists } = fakes({ 'saga-dash': { branch: 'main' } });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    // branch warn (expected local/integration), but NO "#410" pin line.
    expect(r.posture.some((l) => l.message.includes('posture drift'))).toBe(true);
    expect(r.posture.some((l) => l.message.includes('#410'))).toBe(false);
  });
});

describe('P3 — unpinned overlays (set-subtraction)', () => {
  it('a merged branch NOT in the pin file ⇒ unpinned-overlay WARN; the pinned one does not', async () => {
    // pin #410 → branch feat/pinned; the checkout also merged feat/adhoc (unpinned).
    const pins = new Map([['saga-dash', '410']]);
    const { git, gh, pathExists } = fakes({
      'saga-dash': {
        branch: 'local/integration',
        headOidByPr: { '410': 'sha410' },
        ancestors: ['sha410'],
        headRefByPr: { '410': 'feat/pinned' },
        prNumByBranch: { 'feat/adhoc': '999' },
        mergeSubjects: [
          "Merge remote-tracking branch 'origin/feat/pinned' into local/integration",
          "Merge remote-tracking branch 'origin/feat/adhoc' into local/integration",
        ].join('\n'),
      },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    const unpinned = r.posture.find((l) => l.message.includes('unpinned overlay(s)'));
    expect(unpinned?.level).toBe('warn');
    expect(unpinned?.message).toContain('#999 feat/adhoc'); // decorated, and NOT feat/pinned
    expect(unpinned?.message).not.toContain('feat/pinned');
    warnOnly(r.posture);
  });

  it('every merged branch is pinned ⇒ no unpinned-overlay warning', async () => {
    const pins = new Map([['saga-dash', '410']]);
    const { git, gh, pathExists } = fakes({
      'saga-dash': {
        branch: 'local/integration',
        headOidByPr: { '410': 'sha410' },
        ancestors: ['sha410'],
        headRefByPr: { '410': 'feat/pinned' },
        mergeSubjects: "Merge remote-tracking branch 'origin/feat/pinned' into local/integration",
      },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    expect(r.posture.some((l) => l.message.includes('unpinned overlay'))).toBe(false);
  });
});

describe('P4 — freshness', () => {
  it('behind origin ⇒ WARN (no fail)', async () => {
    const { git, gh, pathExists } = fakes({ qboard: { behind: 4 } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    expect(r.freshness.some((l) => l.level === 'warn' && l.message.includes('4 behind'))).toBe(true);
  });

  it('fetch failure ⇒ WARN "freshness unknown", never throws', async () => {
    const { git, gh, pathExists } = fakes({ rtsm: { fetchOk: false } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    expect(r.freshness.some((l) => l.level === 'warn' && l.message.includes('fetch failed'))).toBe(true);
  });

  it('a feature-branch repo is NOT a freshness candidate (skipped, no line)', async () => {
    const { git, gh, pathExists } = fakes({ 'program-hub': { branch: 'feature/x' } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    expect(r.freshness.some((l) => l.message.includes('program-hub'))).toBe(false);
  });
});

describe('edge cases — never fail, never throw', () => {
  it('an overlay row naming a non-postureable repo ⇒ WARN "can\'t posture-check"', async () => {
    const { git, gh, pathExists } = fakes();
    const r = await assessPosture({ resolvePath: P, pins: new Map([['coach', '1']]), git, gh, pathExists });
    expect(r.posture.some((l) => l.level === 'warn' && l.message.includes("overlay lists 'coach'"))).toBe(true);
  });

  it('a repo whose .git is missing ⇒ WARN (verify.sh badline DOWNGRADED), and freshness skips it', async () => {
    const { git, gh, pathExists } = fakes({ rostering: { missing: true } });
    const r = await assessPosture({ resolvePath: P, pins: new Map(), git, gh, pathExists });
    const notGit = r.posture.find((l) => l.message.includes('rostering'));
    expect(notGit?.level).toBe('warn'); // NOT a failure
    expect(notGit?.message).toContain('not a git repo');
    expect(r.freshness.some((l) => l.message.includes('rostering'))).toBe(false);
    warnOnly([...r.posture, ...r.freshness]);
  });

  it('THE INVARIANT: a fully-dirty posture produces ONLY warn/ok/note lines (no fail path exists)', async () => {
    const pins = new Map([['saga-dash', '410']]);
    const { git, gh, pathExists } = fakes({
      'saga-dash': { branch: 'local/integration', headOidByPr: { '410': '' }, behind: 9 },
      rostering: { branch: 'feature/x' },
      'program-hub': { branch: 'local/integration', diffQuiet: false, behind: 3 },
      qboard: { fetchOk: false },
      soa: { branch: 'local/integration', behind: 12 },
    });
    const r = await assessPosture({ resolvePath: P, pins, git, gh, pathExists });
    warnOnly([...r.posture, ...r.freshness]);
    // and it really detected drift (this isn't a no-op) — at least one warn present.
    expect([...r.posture, ...r.freshness].some((l) => l.level === 'warn')).toBe(true);
  });
});
