/**
 * `saga-stack stack bootstrap` — one command to stand up the synthetic-dev stack on main.
 *
 * M11: NATIVE-BY-DEFAULT. bootstrap.sh's 4-step chain is now driven natively:
 *   1. ensure-repos   — `ensureReposNative`: clone any MISSING of the 7 required siblings
 *                       (worktree-safe `.git` check; NO silent auto-clone — TTY [y/N] /
 *                       `--yes` / no-TTY-fail-fast; the install half rides native prep).
 *   2. overlay        — native `stack overlay apply` (M10) unless `--no-refresh`.
 *   3. up --reset     — native `stack up --reset --seed <p>` (StackApi.up; M8/M9).
 *   4. verify         — native `stack verify` (M2 + M9 DATA).
 * STAGED fail-before-up: an ensure/clone failure ABORTS before step 2/3 (a late
 * prep-install failure must not subsume the explicit clone step).
 *
 * `--yes` is the NATIVE non-interactive auto-confirm.
 *
 *   node bin/dev.js stack bootstrap
 *   node bin/dev.js stack bootstrap --no-refresh --seed full
 *   node bin/dev.js stack bootstrap --yes            # non-interactive (CI/agent): auto-clone
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import { REPO_ENV_VAR, bootstrapRepos, ensureReposNative } from '../../runtime/index.js';
import { repoContextFromFlags } from './status.js';
import StackOverlay from './overlay.js';
import StackUp from './up.js';
import StackVerify from './verify.js';

export default class StackBootstrap extends BaseCommand {
  static description =
    'Stand up the synthetic-dev stack on main: ensure repos → overlay → up --reset --seed → verify (native).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --no-refresh --seed full',
    '<%= config.bin %> <%= command.id %> --yes',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'no-refresh': Flags.boolean({
      description: 'skip the overlay step (native overlay apply / bootstrap.sh --no-refresh)',
      default: false,
    }),
    seed: Flags.string({
      description: 'seed profile for the up step (up --reset --seed <roster|full>)',
      options: ['roster', 'full'],
      default: 'roster',
    }),
    yes: Flags.boolean({
      description:
        'non-interactive auto-confirm: clone any missing sibling repos WITHOUT a TTY prompt (for CI / background agents).',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackBootstrap);

    // ── NATIVE chain ──
    const ws = this.workspaceArgs(flags);

    // STEP 1 — ensure repos (the delta; STAGED fail-before-up). Clone only via --yes
    // or a TTY 'yes'; NEVER silently.
    await this.step('1/4 ensure repos — clone any missing of the 7 required siblings', async () => {
      const ctx = repoContextFromFlags(flags as unknown as Record<string, unknown>);
      const result = await ensureReposNative(
        bootstrapRepos(ctx),
        { yes: flags.yes },
        {
          git: this.getGitRunner(),
          confirm: this.getConfirm(),
          pathExists: this.getRepoDirCheck(),
          notify: (m) => this.log(m),
        },
      );
      if (!result.ok) {
        // Faithful to bootstrap.sh's three giving-up messages — abort BEFORE any up.
        if (result.aborted === 'no-tty') {
          this.error(
            'non-interactive and no --yes — refusing to clone unprompted. Re-run with --yes, ' +
              'or clone the repo(s) above by hand (git clone git@github.com:saga-ed/<repo>.git), then re-run.',
          );
        }
        if (result.aborted === 'declined') {
          this.error('cannot continue without all required sibling repos cloned.');
        }
        this.error(
          `clone failed for ${result.failedRepo ?? '(unknown)'} — clone it by hand, then re-run.`,
        );
      }
    });

    // STEP 2 — overlay apply (native, M10), unless --no-refresh.
    if (flags['no-refresh']) {
      this.log('▶ 2/4 overlay — SKIPPED (--no-refresh)');
    } else {
      await this.step('2/4 overlay — apply your local overlay if present (else everyone on main)', () =>
        StackOverlay.run(['apply', ...ws], this.config),
      );
    }

    // STEP 3 — native up --reset --seed <profile> (StackApi.up; a bare `up` expands to the
    // full non-optional closure natively — exactly bootstrap.sh's step 3).
    await this.step(`3/4 up — mesh + services + reset + seed ${flags.seed}`, () =>
      StackUp.run(['--reset', '--seed', flags.seed, ...ws], this.config),
    );

    // STEP 4 — native verify (M2 health + M9 DATA).
    await this.step('4/4 verify — assert every service is green + the roster seeded', () =>
      StackVerify.run([...ws], this.config),
    );

    this.log("✓ bootstrap complete — you're in the team's synthetic-dev state.");
  }

  /**
   * Run one chain step, stopping at the first failure (bootstrap.sh's "stop at the first
   * failing step"). A sub-command's `this.exit(nonzero)` throws an oclif ExitError — we
   * log a pointed step-failure line and RE-THROW so the exit code propagates to CI.
   */
  private async step(label: string, fn: () => Promise<unknown>): Promise<void> {
    this.log(`▶ ${label}`);
    try {
      await fn();
    } catch (err) {
      this.log(`✗ step failed: ${label} — resolve the above, then re-run.`);
      throw err;
    }
  }

  /**
   * Reconstruct the workspace-resolution argv (`--dev` + per-repo pins + `--state-dir`)
   * to forward to the native sub-commands, so overlay/up/verify resolve the SAME repo
   * checkouts + state dir this bootstrap did. Output/seed/`--yes` are bootstrap-only.
   */
  private workspaceArgs(flags: WorkspaceFlags & { 'state-dir'?: string }): string[] {
    const args: string[] = [];
    if (flags.dev) args.push('--dev', flags.dev);
    for (const kebab of Object.keys(REPO_ENV_VAR) as (keyof typeof REPO_ENV_VAR)[]) {
      const value = (flags as unknown as Record<string, string | undefined>)[kebab];
      if (value) args.push(`--${kebab}`, value);
    }
    if (flags['state-dir']) args.push('--state-dir', flags['state-dir']);
    return args;
  }
}
