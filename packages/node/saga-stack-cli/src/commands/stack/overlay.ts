/**
 * `saga-stack stack overlay <verb>` — overlay your in-flight PRs onto a main-based
 * synthetic-dev.
 *
 * M10: the GIT half (apply / list / reset) is now NATIVE — the in-process overlay
 * engine (`runtime/overlay.ts` + `core/overlay-plan.ts`) rebuilds each managed repo's
 * LOCAL-ONLY `local/integration` branch = `origin/<base>` + a `--no-ff` merge of each
 * PR/branch, drives `gh` per-repo to resolve numeric PRs, and owns the exit-code
 * contract (0 clean / 1 if any repo conflicted-or-missing) — byte-faithful to
 * refresh-suite.sh 125-195 / 346-408.
 *
 * STILL WRAPPED (sole implementation — no native path):
 *   - `compose-rest` — the cloud sandbox orchestrator (AWS Secrets / HTTP / 20m poll,
 *     creates real billable sandboxes). Routes to refresh-suite.sh via a `ScriptPlan`,
 *     preserving its exit-2 ("spec printed, composed NOTHING") semantics + BASE/SANDBOX_*
 *     env contract.
 *
 * Verbs:
 *   apply [--prs <#s|branch> <repo…>]   bare → apply integration-suite.local.tsv;
 *                                        with --prs → ad-hoc overlay of an explicit set
 *   list                                 print your personal overlay file
 *   reset [repo…]                        back overlaid repos out to <base>
 *   compose-rest <name> [--base/--ttl-hours/--seed-profile/--bypass-header]  (wrapped)
 *
 *   node bin/dev.js stack overlay list
 *   node bin/dev.js stack overlay apply --prs 165 saga-dash
 *   node bin/dev.js stack overlay reset rostering
 *   node bin/dev.js stack overlay compose-rest dev --ttl-hours 6
 */

import { basename, dirname, join } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import * as flagMap from '../../core/flag-map.js';
import { SYNTH_DEV_DIR } from '../../core/flag-map.js';
import type { OverlayVerb } from '../../core/flag-map.js';
import {
  MANAGED_REPOS,
  overlayExitCode,
  parseOverlayTsv,
  refreshFailed,
  resetExitCode,
  resetFailed,
} from '../../core/index.js';
import type { RefreshOutcome, ResetOutcome } from '../../core/index.js';
import {
  applyOverlay,
  resetOverlay,
  resolveOverlayRepo,
  resolveRepoRoot,
  resolveVendorScript,
  INTEGRATION_BRANCH,
} from '../../runtime/index.js';
import type { RefreshRepoTarget, ResetRepoTarget, ScriptContext } from '../../runtime/index.js';
import { repoContextFromFlags } from './status.js';

const VERBS: readonly OverlayVerb[] = ['apply', 'list', 'reset', 'compose-rest'];

/** The personal overlay file + its example, under soa's synthetic-dev dir. */
const OVERLAY_TSV = 'integration-suite.local.tsv';
const OVERLAY_EXAMPLE = 'integration-suite.example.tsv';

export default class StackOverlay extends BaseCommand {
  static description =
    'Overlay your in-flight PRs onto a main-based synthetic-dev (native git engine; compose-rest wraps refresh-suite.sh).';

  static examples = [
    '<%= config.bin %> <%= command.id %> list',
    '<%= config.bin %> <%= command.id %> apply --prs 165 saga-dash',
    '<%= config.bin %> <%= command.id %> reset rostering',
    '<%= config.bin %> <%= command.id %> compose-rest dev --ttl-hours 6',
  ];

  // Trailing positionals vary by verb (repo list for apply/reset, sandbox name
  // for compose-rest), so accept extra args and read them off `argv`.
  static strict = false;

  static args = {
    verb: Args.string({
      description: 'overlay action',
      options: [...VERBS],
      default: 'apply',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    prs: Flags.string({
      description:
        'apply: ad-hoc PR/branch set to overlay (numeric → gh PR head ref; bare name → literal branch); requires one or more trailing repo names',
    }),
    base: Flags.string({
      description: 'base ref the overlay rebuilds on (refresh-suite.sh env BASE; default main)',
    }),
    'ttl-hours': Flags.string({
      description: 'compose-rest: sandbox TTL in hours (refresh-suite.sh env SANDBOX_TTL_HOURS)',
    }),
    'seed-profile': Flags.string({
      description: 'compose-rest: sandbox seed profile (refresh-suite.sh env SANDBOX_SEED_PROFILE)',
    }),
    'bypass-header': Flags.string({
      description:
        "compose-rest: ALB-perimeter bypass header 'Name: value' (refresh-suite.sh env SANDBOX_BYPASS_HEADER). Omit to print the spec only (exit 2, composes nothing).",
    }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(StackOverlay);

    // argv = positional tokens only (oclif strips flags). argv[0] is the verb;
    // the remainder are repo names (apply/reset) or the sandbox name (compose-rest).
    const positionals = argv as string[];
    const verb = (positionals[0] ?? 'apply') as string;
    const rest = positionals.slice(1);

    if (!VERBS.includes(verb as OverlayVerb)) {
      this.error(`unknown overlay verb '${verb}'. Use one of: ${VERBS.join(', ')}.`);
    }
    const v = verb as OverlayVerb;

    // Per-verb argument validation (friendly, before the engine/bash would reject it).
    if (v === 'compose-rest' && rest.length !== 1) {
      this.error('overlay compose-rest needs exactly one sandbox name, e.g. `overlay compose-rest dev`.');
    }
    if (v === 'apply' && flags.prs && rest.length === 0) {
      this.error('overlay apply --prs needs at least one repo, e.g. `overlay apply --prs 165 saga-dash`.');
    }
    if (v === 'apply' && !flags.prs && rest.length > 0) {
      // Bare `apply` is file-driven (reads integration-suite.local.tsv) and
      // ignores positional repos — silently dropping them would surprise the
      // user. Require --prs to act on an explicit repo set.
      this.error(
        `overlay apply ignores positional repos unless --prs is given (bare apply is file-driven). Did you mean \`overlay apply --prs <#s|branch> ${rest.join(' ')}\`?`,
      );
    }
    if (v === 'list' && rest.length > 0) {
      this.error('overlay list takes no positional arguments.');
    }

    // compose-rest ALWAYS wraps (cloud orchestrator — the sole implementation, no
    // native path). apply/list/reset are native (below). Phase 1 DECOUPLING
    // (saga-ed/soa#214): the script is the CLI's VENDORED copy (vendor/refresh-suite.sh),
    // resolved via `resolveVendorScript` — NOT soa's tools/synthetic-dev/refresh-suite.sh.
    // The exit-2 ("spec printed, composed NOTHING") semantics + BASE/SANDBOX_* env-not-argv
    // contract are preserved: `flagMap.overlay` still maps the argv/env, and `runVendor`
    // propagates the child exit code verbatim.
    if (v === 'compose-rest') {
      const plan = flagMap.overlay(v, {
        sandbox: rest[0],
        base: flags.base,
        ttlHours: flags['ttl-hours'],
        seedProfile: flags['seed-profile'],
        bypassHeader: flags['bypass-header'],
      });
      const script = resolveVendorScript('refresh-suite.sh');
      // B1 (saga-ed/soa#214): the VENDORED refresh-suite.sh lives under vendor/ (no pin
      // manifest), so point it at the dev's REAL per-dev pin file in the soa checkout —
      // the SAME `tools/synthetic-dev/integration-suite.local.tsv` the native
      // apply/list/reset read (via `overlayPaths`). Without this, PINS is empty and
      // compose-rest composes EVERY managed repo instead of the complement of the
      // dev's pinned set. Env override honored by the vendored copy's MANIFEST/EXAMPLE.
      const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
      const { manifest, example } = this.overlayPaths(ctx);
      await this.runVendor(
        {
          cwd: dirname(script),
          command: script,
          args: plan.args,
          env: { ...plan.env, OVERLAY_FILE: manifest, OVERLAY_EXAMPLE_FILE: example },
        },
        flags,
      );
      return;
    }

    // ── NATIVE git engine ──
    const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
    const base = flags.base || process.env.BASE || 'main'; // || (not ??) so empty BASE/--base '' falls back to main (bash ${BASE:-main})

    if (v === 'list') {
      this.runList(flags, ctx);
      return;
    }
    if (v === 'reset') {
      await this.runReset(flags, ctx, base, rest);
      return;
    }
    await this.runApply(flags, ctx, base, rest);
  }

  /** Resolve the personal-overlay-file path (+ example) under the resolved soa checkout. */
  private overlayPaths(ctx: ScriptContext): { manifest: string; example: string } {
    const synth = join(resolveRepoRoot('SOA', ctx), SYNTH_DEV_DIR);
    return { manifest: join(synth, OVERLAY_TSV), example: join(synth, OVERLAY_EXAMPLE) };
  }

  /** `overlay list` — print the personal overlay file (refresh-suite.sh 346-362). */
  private runList(flags: EmitFlags, ctx: ScriptContext): void {
    const { manifest, example } = this.overlayPaths(ctx);
    const text = this.getOverlayFs().readManifest(manifest);
    const rows = text === null ? [] : parseOverlayTsv(text);

    if (flags['output-json']) {
      this.log(JSON.stringify({ manifest, present: text !== null, rows }, null, 2));
      return;
    }

    this.log(`Personal overlay (${manifest}):`);
    if (text === null) {
      this.log(
        `  (no local overlay — every repo stays on origin/main; cp ${basename(example)} ${basename(manifest)} to add one)`,
      );
      return;
    }
    if (rows.length === 0) {
      this.log('  (none — every repo stays on origin/main)');
      return;
    }
    for (const r of rows) this.log(`  ${r.repo.padEnd(20)} PRs: ${r.prs}`);
  }

  /** `overlay apply` — native git engine (ad-hoc `--prs` or file-driven tsv). */
  private async runApply(
    flags: EmitFlags,
    ctx: ScriptContext,
    base: string,
    rest: string[],
  ): Promise<void> {
    let targets: RefreshRepoTarget[];

    if (flags.prs) { // truthy (not !==undefined) so --prs '' falls through to the file-driven path (bash [[ -n ]])
      // ad-hoc: apply the same PR set to each named repo.
      targets = rest.map((name) => {
        const { path, overridden } = resolveOverlayRepo(name, ctx);
        return { name, path, overridden, prsCsv: flags.prs as string, base };
      });
    } else {
      // file-driven: read + parse integration-suite.local.tsv.
      const { manifest } = this.overlayPaths(ctx);
      const text = this.getOverlayFs().readManifest(manifest);
      const rows = text === null ? [] : parseOverlayTsv(text);
      if (rows.length === 0) {
        // Absent/empty overlay is the VALID common default: everything on main.
        if (flags['output-json']) {
          this.log(JSON.stringify({ verb: 'apply', repos: [], passed: true }, null, 2));
        } else {
          this.log('✓ no local overlay — every repo stays on origin/main (nothing to refresh)');
        }
        return;
      }
      targets = [];
      const skipped: string[] = [];
      for (const r of rows) {
        if (r.prs === '') {
          skipped.push(r.repo);
          continue; // "no PRs listed, skipping" — rc unaffected.
        }
        const { path, overridden } = resolveOverlayRepo(r.repo, ctx);
        targets.push({ name: r.repo, path, overridden, prsCsv: r.prs, base });
      }
      if (!flags['output-json'] && !flags.porcelain) {
        for (const name of skipped) this.log(`· ${name} — no PRs listed, skipping`);
      }
    }

    const outcomes = await applyOverlay(targets, {
      git: this.getGitRunner(),
      gh: this.getGhRunner(),
      pathExists: this.getRepoDirCheck(),
    });
    const code = overlayExitCode(outcomes);

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            verb: 'apply',
            base,
            repos: outcomes.map((o) => ({ ...o, failed: refreshFailed(o) })),
            passed: code === 0,
          },
          null,
          2,
        ),
      );
    } else if (flags.porcelain) {
      for (const o of outcomes) this.log(`${o.name}=${o.status}`);
      this.log(`passed=${code === 0}`);
    } else {
      for (const o of outcomes) this.renderRefresh(o);
      this.log(
        code === 0
          ? '✓ overlay applied — listed repo(s) on local/integration'
          : '✗ overlay applied with issues — resolve above, then re-run',
      );
    }

    if (code !== 0) this.exit(1);
  }

  /** `overlay reset` — native backout to <base> (refresh-suite.sh 376-408). */
  private async runReset(
    flags: EmitFlags,
    ctx: ScriptContext,
    base: string,
    rest: string[],
  ): Promise<void> {
    const names = rest.length > 0 ? rest : [...MANAGED_REPOS];
    const targets: ResetRepoTarget[] = names.map((name) => {
      const { path, overridden } = resolveOverlayRepo(name, ctx);
      return { name, path, overridden, base };
    });

    const outcomes = await resetOverlay(targets, {
      git: this.getGitRunner(),
      pathExists: this.getRepoDirCheck(),
    });
    const code = resetExitCode(outcomes);

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            verb: 'reset',
            base,
            repos: outcomes.map((o) => ({ ...o, failed: resetFailed(o) })),
            passed: code === 0,
          },
          null,
          2,
        ),
      );
    } else if (flags.porcelain) {
      for (const o of outcomes) this.log(`${o.name}=${o.status}`);
      this.log(`passed=${code === 0}`);
    } else {
      for (const o of outcomes) this.renderReset(o);
      this.log(
        code === 0
          ? `✓ backed out — repos on ${base} (your overlay file is untouched)`
          : '✗ backout had issues — see above',
      );
    }

    if (code !== 0) this.exit(1);
  }

  /** Human lines for one refresh outcome (functionally mirrors refresh_repo's ok/warn/err). */
  private renderRefresh(o: RefreshOutcome): void {
    this.log(`=== ${o.name} ===`);
    switch (o.status) {
      case 'overridden':
        this.log(`✓ ${o.name} — overridden to ${o.path}, left as-is (overlay skipped)`);
        return;
      case 'not-git':
        this.log(`✗ ${o.path} is not a git repo — skipping`);
        return;
      case 'dirty':
        this.log(`⚠ modified/staged changes in ${o.name} — skipping (commit/stash first)`);
        return;
      case 'fetch-failed':
        this.log(`✗ fetch failed — skipping ${o.name}`);
        return;
      case 'base-missing':
        this.log(`✗ origin/${o.base} does not exist in ${o.name} — skipping`);
        return;
      case 'no-prs':
        for (const pr of o.notFound) this.log(`⚠ PR #${pr} not found in ${o.name} — skipping`);
        this.log(`✓ no PRs to merge — ${INTEGRATION_BRANCH} == origin/${o.base}`);
        return;
      case 'merged':
        for (const pr of o.notFound) this.log(`⚠ PR #${pr} not found in ${o.name} — skipping`);
        this.log(`✓ merged: ${o.merged.join(' ') || '(none)'}`);
        if (o.conflicted.length > 0) this.log(`⚠ conflicted: ${o.conflicted.join(' ')}`);
        if (o.missing.length > 0) this.log(`⚠ missing on origin: ${o.missing.join(' ')}`);
        return;
    }
  }

  /** Human lines for one reset outcome (functionally mirrors the --reset loop). */
  private renderReset(o: ResetOutcome): void {
    switch (o.status) {
      case 'overridden':
        this.log(`✓ ${o.name} — overridden to ${o.path}, never overlaid; nothing to reset`);
        return;
      case 'not-git':
        this.log(`⚠ ${o.name} — not a git repo at ${o.path}; skipping`);
        return;
      case 'not-overlaid':
        this.log(`✓ ${o.name} already on '${o.branch || '?'}' (not overlaid)`);
        if (o.deletedStale) this.log(`→ ${o.name} — removed stale ${INTEGRATION_BRANCH} branch`);
        return;
      case 'dirty':
        this.log(`⚠ ${o.name} — uncommitted changes on ${INTEGRATION_BRANCH}; commit/stash first, skipping`);
        return;
      case 'reset':
        this.log(`✓ ${o.name} → ${o.base} (${INTEGRATION_BRANCH} removed)`);
        return;
      case 'checkout-failed':
        this.log(`✗ ${o.name} — couldn't checkout ${o.base}; resolve manually`);
        return;
    }
  }
}

/** The output flags the render paths read (subset of the parsed global flags). */
interface EmitFlags {
  porcelain: boolean;
  'output-json': boolean;
  prs?: string;
}
