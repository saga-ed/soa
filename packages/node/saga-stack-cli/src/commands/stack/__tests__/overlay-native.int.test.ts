/**
 * `stack overlay` NATIVE integration tests (M10 repoint).
 *
 * Drive the REAL oclif command end-to-end but REPLACE its seams on the BaseCommand
 * prototype:
 *   - `getGitRunner` / `getGhRunner` — fake git/gh (no real repo/network).
 *   - `getOverlayFs` — canned `integration-suite.local.tsv` text.
 *   - `getRepoDirCheck` — a fake `.git` existence predicate.
 *   - `getRunner` — the ScriptPlan (bash) seam; asserted NOT called for the native
 *     verbs, and IS called for `compose-rest` / `--legacy`.
 *
 * The repoint contract: `overlay apply|list|reset` run NATIVELY (never the Runner);
 * `overlay compose-rest` and any `--legacy` verb still route to refresh-suite.sh.
 */

import { resolve } from 'node:path';
import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { GitRunner } from '../../../runtime/index.js';
import type { GhRunner, OverlayFs } from '../../../runtime/index.js';
import type { RunResult, ScriptInvocation } from '../../../runtime/index.js';
import StackOverlay from '../overlay.js';

const PKG_ROOT = process.cwd();
const SOA_ROOT = resolve(PKG_ROOT, '..', '..', '..');
const REFRESH_SH = resolve(SOA_ROOT, 'tools', 'synthetic-dev', 'refresh-suite.sh');
const DEV_ROOT = '/fixed/dev';
const WS = ['--soa', SOA_ROOT, '--dev', DEV_ROOT];

let config: Config;
let runnerCalls: ScriptInvocation[];
let gitCalls: string[];
let ghCalls: { pr: string; cwd: string }[];
let logged: string[];

/** A fake git seam recording every call; refs/merges scripted per path. */
function installFakeGit(byPath: Record<string, { existingRefs?: string[]; branch?: string; porcelain?: string }> = {}): void {
  gitCalls = [];
  const s = (p: string) => byPath[p] ?? {};
  const git: GitRunner = {
    async statusPorcelain(p) {
      return s(p).porcelain ?? '';
    },
    async branchShowCurrent(p) {
      return s(p).branch ?? 'main';
    },
    async symbolicRefDefault() {
      return 'main';
    },
    async fetch(p) {
      gitCalls.push(`fetch ${p}`);
      return true;
    },
    async hasUpstream() {
      return true;
    },
    async revListCount() {
      return 0;
    },
    async mergeFfOnly() {
      return true;
    },
    async revParseVerify(p, ref) {
      return (s(p).existingRefs ?? []).includes(ref);
    },
    async checkoutB(p, branch, startPoint) {
      gitCalls.push(`checkout-B ${p} ${branch} ${startPoint}`);
      return true;
    },
    async merge(p, ref) {
      gitCalls.push(`merge ${p} ${ref}`);
      return true;
    },
    async mergeAbort() {
      return true;
    },
    async branchDelete(p, name) {
      gitCalls.push(`branch-delete ${p} ${name}`);
      return true;
    },
    async checkout(p, ref) {
      gitCalls.push(`checkout ${p} ${ref}`);
      return true;
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getGitRunner: () => unknown }, 'getGitRunner').mockReturnValue(git);
}

function installFakeGh(byPr: Record<string, string> = {}): void {
  ghCalls = [];
  const gh: GhRunner = {
    async prHeadRef(pr, cwd) {
      ghCalls.push({ pr, cwd });
      return byPr[pr] ?? '';
    },
  };
  vi.spyOn(BaseCommand.prototype as unknown as { getGhRunner: () => unknown }, 'getGhRunner').mockReturnValue(gh);
}

function installFakeOverlayFs(text: string | null): void {
  const fs: OverlayFs = { readManifest: () => text };
  vi.spyOn(BaseCommand.prototype as unknown as { getOverlayFs: () => unknown }, 'getOverlayFs').mockReturnValue(fs);
}

function installFakeRepoDirCheck(exists: (p: string) => boolean): void {
  vi.spyOn(
    BaseCommand.prototype as unknown as { getRepoDirCheck: () => unknown },
    'getRepoDirCheck',
  ).mockReturnValue(exists);
}

/** The ScriptPlan (bash) seam — asserted NOT called for native verbs. */
function installFakeRunner(code = 0): void {
  runnerCalls = [];
  vi.spyOn(BaseCommand.prototype as unknown as { getRunner: () => unknown }, 'getRunner').mockReturnValue({
    async run(spec: ScriptInvocation): Promise<RunResult> {
      runnerCalls.push(spec);
      return { code };
    },
  });
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  logged = [];
  vi.spyOn(BaseCommand.prototype as unknown as { log: (m?: string) => void }, 'log').mockImplementation(
    (m?: string) => {
      logged.push(m ?? '');
    },
  );
  installFakeRunner(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const out = (): string => logged.join('');

describe('overlay apply — native git engine (no Runner)', () => {
  it('apply --prs <n> <repo> drives git+gh NATIVELY and never spawns refresh-suite.sh', async () => {
    installFakeGit({ '/fixed/dev/saga-dash': { existingRefs: ['origin/main', 'origin/feat-a'] } });
    installFakeGh({ '165': 'feat-a' });
    installFakeRepoDirCheck(() => true);

    await StackOverlay.run(['apply', '--prs', '165', 'saga-dash', ...WS], config);

    // native: the bash Runner was NEVER called.
    expect(runnerCalls).toHaveLength(0);
    // gh resolved the PR in the REPO's cwd; the branch was merged onto local/integration.
    expect(ghCalls).toEqual([{ pr: '165', cwd: '/fixed/dev/saga-dash' }]);
    expect(gitCalls).toContain('checkout-B /fixed/dev/saga-dash local/integration origin/main');
    expect(gitCalls).toContain('merge /fixed/dev/saga-dash origin/feat-a');
  });

  it('a conflicted/missing overlay exits 1 (native exit-code contract)', async () => {
    // origin/feat-a resolvable but missing on origin ⇒ missing ⇒ exit 1.
    installFakeGit({ '/fixed/dev/saga-dash': { existingRefs: ['origin/main'] } });
    installFakeGh({ '165': 'feat-a' });
    installFakeRepoDirCheck(() => true);

    await expect(
      StackOverlay.run(['apply', '--prs', '165', 'saga-dash', ...WS], config),
    ).rejects.toMatchObject({ oclif: { exit: 1 } });
    expect(runnerCalls).toHaveLength(0);
  });

  it('bare apply reads the overlay file NATIVELY (file-driven) and never spawns bash', async () => {
    installFakeGit({ '/fixed/dev/rostering': { existingRefs: ['origin/main'] } });
    installFakeGh({});
    installFakeOverlayFs('rostering\t\n'); // repo present, no PRs listed → skipped
    installFakeRepoDirCheck(() => true);

    await StackOverlay.run(['apply', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    expect(out()).toContain('no PRs listed');
  });

  it('bare apply with NO overlay file is the clean no-op default (exit 0, no bash)', async () => {
    installFakeGit();
    installFakeGh({});
    installFakeOverlayFs(null);
    installFakeRepoDirCheck(() => true);

    await StackOverlay.run(['apply', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    expect(out()).toContain('every repo stays on origin/main');
  });
});

describe('overlay list — native (prints the overlay file, no Runner)', () => {
  it('prints tsv rows padded, and never spawns bash', async () => {
    installFakeOverlayFs('# header\nrostering\t410,432\nsaga-dash\t165\n');
    await StackOverlay.run(['list', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    const text = out();
    expect(text).toContain('rostering'.padEnd(20) + ' PRs: 410,432');
    expect(text).toContain('saga-dash'.padEnd(20) + ' PRs: 165');
  });

  it('an absent overlay file prints the cp hint (native)', async () => {
    installFakeOverlayFs(null);
    await StackOverlay.run(['list', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    expect(out()).toContain('no local overlay');
  });
});

describe('overlay reset — native (no Runner)', () => {
  it('reset <repo> drives git NATIVELY (checks out base, deletes local/integration)', async () => {
    installFakeGit({ '/fixed/dev/rostering': { branch: 'local/integration', porcelain: '' } });
    installFakeRepoDirCheck(() => true);

    await StackOverlay.run(['reset', 'rostering', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    expect(gitCalls).toContain('checkout /fixed/dev/rostering main');
    expect(gitCalls).toContain('branch-delete /fixed/dev/rostering local/integration');
  });

  it('bare reset defaults to the managed repos (native)', async () => {
    installFakeGit({});
    installFakeRepoDirCheck(() => false); // none cloned → not-git warn, rc 0
    await StackOverlay.run(['reset', ...WS], config);
    expect(runnerCalls).toHaveLength(0);
    // touched all three managed repos.
    const text = out();
    for (const r of ['rostering', 'program-hub', 'saga-dash']) expect(text).toContain(r);
  });
});

describe('overlay compose-rest / --legacy — still wrap refresh-suite.sh', () => {
  it('compose-rest routes to the bash Runner (ScriptPlan), not the native engine', async () => {
    installFakeGit();
    installFakeGh({});
    await StackOverlay.run(['compose-rest', 'dev', ...WS], config);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].command).toBe(REFRESH_SH);
    expect(runnerCalls[0].args).toEqual(['--compose-rest', 'dev']);
  });

  it('--legacy reset routes to the bash Runner (whole-verb escape)', async () => {
    installFakeGit();
    await StackOverlay.run(['reset', '--legacy', 'rostering', ...WS], config);
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].command).toBe(REFRESH_SH);
    expect(runnerCalls[0].args).toEqual(['--reset', 'rostering']);
  });
});
