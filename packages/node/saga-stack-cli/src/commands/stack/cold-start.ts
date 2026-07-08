/**
 * `saga-stack stack cold-start` — the ONE command to return the box to a pristine, tutorial-ready
 * synthetic-dev state (soa#cold-start).
 *
 * Where `bootstrap` stands the stack up on main NON-destructively (clone-if-missing → overlay →
 * up → verify), `cold-start` is the SLEDGEHAMMER for a guaranteed-clean baseline. Six phases:
 *
 *   1. DOCKER WIPE   — stop the slot's services, then `docker compose … down -v --remove-orphans`
 *                      so the mesh CONTAINERS **and their volumes (the DB data)** are gone. With
 *                      `--all-docker`, also `docker system prune -af --volumes` (host-global nuke).
 *   2. ENSURE REPOS  — clone any missing of the 7 required siblings (bootstrap's step 1; `--yes`).
 *   3. REPOS → MAIN  — switch every clean repo back to its default branch + fast-forward to origin.
 *                      A repo with uncommitted TRACKED changes is LEFT AS-IS (never discarded).
 *   4. CLEAN BUILD   — `rm -rf` each repo's `dist/` (defeats prep's fresh-skip) so `up` rebuilds;
 *                      `--reinstall` also removes `node_modules` for a full `pnpm install`. This
 *                      wipes the HOST repo's (soa) OWN runtime — the `dist/commands/**` and (under
 *                      `--reinstall`) the `node_modules/@oclif/core` the running `ss` loads from —
 *                      and step 6's up only builds the SERVICE repos, never soa. So soa is restored
 *                      INLINE right here: reinstall (under `--reinstall`) + a CLI rebuild (always),
 *                      or the next `ss` command dies with MODULE_NOT_FOUND even after a green run.
 *                      Siblings still reinstall/rebuild in step 6's up/prep.
 *   5. ENSURE .ENV   — copy each `.env.example` → `.env` where the `.env` is missing (never
 *                      overwrites), so a fresh clone has the dotenv files the services expect.
 *   6. UP + VERIFY   — `up --reset --seed <profile>` (fresh mesh → provision → migrate → seed) then
 *                      `verify` — the same native path bootstrap ends on.
 *
 * SAFETY: the wipe is destructive, so a plain run PROMPTS once up front (skip with `--yes`, or
 * preview the whole plan with `--dry-run`, which touches NOTHING). The scoped compose wipe only
 * ever targets the saga mesh's OWN project; `--all-docker` is the only path that touches unrelated
 * docker state, and it rides the same single confirm.
 *
 * SLOT-0 ONLY (like `restart`): a cold start re-bases the shared baseline; a `--slot > 0` is
 * rejected by the central guard.
 *
 *   ss stack cold-start --dry-run          # preview every phase, change nothing
 *   ss stack cold-start                     # prompt, then run (scoped docker wipe)
 *   ss stack cold-start --yes               # non-interactive (agent/CI)
 *   ss stack cold-start --all-docker --reinstall --seed full   # the full nuke
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import type { WorkspaceFlags } from '../../base-command.js';
import {
  REPO_ENV_VAR,
  bootstrapRepos,
  composeDownVArgs,
  distScanRoots,
  HOST_CLI_PACKAGE,
  ensureEnv,
  ensureReposNative,
  rebuildHostCli,
  reinstallHostRepo,
  reinstallTargets,
  reposToMain,
  resolveRepoRoot,
  systemPruneArgs,
} from '../../runtime/index.js';
import { deriveInstance } from '../../core/derive-instance.js';
import StackUp from './up.js';
import StackVerify from './verify.js';

export default class StackColdStart extends BaseCommand {
  static description =
    'Return the box to a pristine synthetic-dev baseline: docker wipe (down -v) → ensure repos → ' +
    'repos to main → clean build → ensure .env → up --reset --seed → verify. Destructive; slot-0 only.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --yes',
    '<%= config.bin %> <%= command.id %> --all-docker --reinstall --seed full',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'dry-run': Flags.boolean({
      description: 'preview every phase without changing anything (no docker/git/fs/up).',
      default: false,
    }),
    yes: Flags.boolean({
      description:
        'non-interactive: skip the destructive-action prompt AND auto-clone missing repos (CI / agents).',
      default: false,
    }),
    'all-docker': Flags.boolean({
      description:
        'NUKE: also run `docker system prune -af --volumes` (removes ALL unused docker on the host, not just the mesh).',
      default: false,
    }),
    reinstall: Flags.boolean({
      description: 'also `rm -rf node_modules` in each repo (forces a full pnpm install — slow).',
      default: false,
    }),
    'skip-clean': Flags.boolean({
      description: 'skip the clean-build phase (leave existing dist/ in place).',
      default: false,
    }),
    seed: Flags.string({
      description: 'seed profile for the up phase (up --reset --seed <roster|full>).',
      options: ['roster', 'full'],
      default: 'roster',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(StackColdStart);
    const dry = flags['dry-run'];

    // Slot 0 (guarded — not slotAware). project === 'soa', stateDir === '/tmp/sds-synthetic'.
    const profile = deriveInstance({ slot: flags.slot });
    const ws = this.workspaceArgs(flags);
    const ctx = this.scriptContextFromFlags(flags);
    const repos = bootstrapRepos(ctx);
    const soaRoot = resolveRepoRoot('SOA', ctx);

    // ── plan header + single destructive confirm ──
    this.log(dry ? '▶ cold-start DRY RUN — nothing will be changed:' : '▶ cold-start plan:');
    this.log(`    docker: down -v the '${profile.project}' mesh (containers + volumes)${flags['all-docker'] ? ' + system prune -af --volumes' : ''}`);
    this.log(`    repos:  ${repos.length} siblings → clone-if-missing, switch to main, ff to origin`);
    this.log(`    build:  rm -rf dist${flags.reinstall ? ' + node_modules' : ''}${flags['skip-clean'] ? ' (SKIPPED)' : ''} → rebuilt by up (soa CLI restored inline)`);
    this.log(`    env:    scaffold missing .env from .env.example`);
    this.log(`    up:     up --reset --seed ${flags.seed} → verify`);

    if (!dry && !flags.yes) {
      const ok = await this.getConfirm().prompt(
        '\n  This DESTROYS local mesh data (DB volumes)' +
          (flags['all-docker'] ? ' AND prunes all unused docker' : '') +
          '. Continue? [y/N] ',
      );
      if (!ok) {
        this.log('cold-start aborted — nothing changed.');
        return;
      }
    }

    // ── STEP 1: docker wipe ──
    await this.step('1/6 docker wipe — down -v the mesh (drop containers + data volumes)', async () => {
      if (dry) {
        this.log(`    would run (in ${soaRoot}/infra): docker ${composeDownVArgs(profile.project).join(' ')}`);
        if (flags['all-docker']) this.log(`    would run: docker ${systemPruneArgs().join(' ')}`);
        return;
      }
      // Stop this slot's own dev-server pids first (best-effort) so no watch child keeps a port.
      try {
        await this.getServiceStopper()(flags['state-dir'] ?? profile.stateDir);
      } catch {
        // best-effort — the compose down + orphan removal is what actually frees the mesh.
      }
      const wipe = this.getDockerWipe();
      const down = await wipe.composeDownVolumes({ soaRoot, project: profile.project });
      if (!down.ok) {
        this.log(`⚠ compose down -v exited ${down.code} — continuing (mesh may have been already down)`);
      }
      if (flags['all-docker']) {
        const pruned = await wipe.systemPrune();
        if (!pruned.ok) this.log(`⚠ docker system prune exited ${pruned.code}`);
      }
    });

    // ── STEP 2: ensure repos (clone missing) ──
    await this.step('2/6 ensure repos — clone any missing of the required siblings', async () => {
      if (dry) {
        const missing = repos.filter((r) => !this.getRepoDirCheck()(`${r.path}/.git`));
        this.log(
          missing.length === 0
            ? '    all required repos present'
            : `    would clone: ${missing.map((r) => r.name).join(', ')}`,
        );
        return;
      }
      const result = await ensureReposNative(
        repos,
        { yes: flags.yes },
        {
          git: this.getGitRunner(),
          confirm: this.getConfirm(),
          pathExists: this.getRepoDirCheck(),
          notify: (m) => this.log(m),
        },
      );
      if (!result.ok) {
        if (result.aborted === 'no-tty') {
          this.error('non-interactive and no --yes — refusing to clone unprompted. Re-run with --yes.');
        }
        if (result.aborted === 'declined') this.error('cannot continue without all required sibling repos.');
        this.error(`clone failed for ${result.failedRepo ?? '(unknown)'} — clone it by hand, then re-run.`);
      }
    });

    // ── STEP 3: repos → main ──
    await this.step('3/6 repos → main — switch each clean repo to its default branch + ff to origin', async () => {
      if (dry) {
        this.log('    would fetch, checkout default branch, and ff-merge each present repo (dirty repos left as-is)');
        return;
      }
      const result = await reposToMain(repos, {
        git: this.getGitRunner(),
        pathExists: this.getRepoDirCheck(),
        notify: (m) => this.log(m),
      });
      const dirty = result.repos.filter((r) => r.action === 'skipped-dirty');
      if (dirty.length > 0) {
        this.log(`⚠ ${dirty.length} repo(s) left on their branch (uncommitted changes): ${dirty.map((r) => r.name).join(', ')}`);
      }
      if (!result.ok) this.log('⚠ one or more repos could not be switched — see above (continuing)');
    });

    // ── STEP 4: clean build ──
    if (flags['skip-clean']) {
      this.log('▶ 4/6 clean build — SKIPPED (--skip-clean)');
    } else {
      await this.step(`4/6 clean build — rm -rf dist${flags.reinstall ? ' + node_modules' : ''} (up rebuilds)`, async () => {
        const cleaner = this.getBuildCleaner();
        for (const repo of repos) {
          if (!this.getRepoDirCheck()(`${repo.path}/.git`)) continue;
          if (dry) {
            this.log(`    ${repo.name}: would rm dist under ${distScanRoots(repo.path).map((p) => p.replace(`${repo.path}/`, '')).join(', ')}${flags.reinstall ? ` + ${reinstallTargets(repo.path).map((p) => p.replace(`${repo.path}/`, '')).join(', ')}` : ''}`);
            continue;
          }
          const res = await cleaner.clean(repo.path, { reinstall: flags.reinstall });
          const n = res.removedDist.length + res.removedModules.length;
          this.log(`  ${n > 0 ? '✓' : '·'} ${repo.name.padEnd(20)} removed ${res.removedDist.length} dist${flags.reinstall ? `, ${res.removedModules.length} node_modules` : ''}`);
        }
      });

      // The clean phase just removed `soa/node_modules` — which is where the RUNNING
      // `ss` binary's OWN runtime (@oclif/core, …) lives. Reinstall the host repo
      // INLINE now instead of deferring it to the up/prep pass below: if that pass
      // failed first (e.g. a wedged prep lock), the empty store would brick every
      // later `ss` invocation with ERR_MODULE_NOT_FOUND. See runtime/host-reinstall.ts.
      if (flags.reinstall) {
        await this.step('4/6 host reinstall — pnpm install in soa (restore ss runtime before up)', async () => {
          if (dry) {
            this.log(`    would run: pnpm install in ${soaRoot}`);
            return;
          }
          const result = await reinstallHostRepo(soaRoot, {
            runner: this.getRunner(),
            notify: (m) => this.log(m),
          });
          if (!result.ok) {
            this.error(
              'host-repo `pnpm install` failed — resolve the error above, then re-run ' +
                '(the ss binary needs its own node_modules to continue).',
            );
          }
          this.log('  ✓ soa node_modules reinstalled — ss runtime restored');
        });
      }

      // The clean phase also `rm -rf`'d soa's `dist/` — including the saga-stack-cli
      // `dist/commands/**` the RUNNING `ss` binary discovers its commands from. Phase 6's up
      // only builds the SERVICE repos (never soa), so rebuild the host CLI INLINE now or the
      // next `ss` command dies with MODULE_NOT_FOUND — even after a green cold-start. Runs even
      // WITHOUT --reinstall (dist is always removed). See runtime/host-reinstall.ts#rebuildHostCli.
      await this.step('4/6 host rebuild — turbo build the ss CLI in soa (restore dist before up)', async () => {
        if (dry) {
          this.log(`    would run: pnpm turbo run build --filter=${HOST_CLI_PACKAGE} in ${soaRoot}`);
          return;
        }
        const result = await rebuildHostCli(soaRoot, {
          runner: this.getRunner(),
          notify: (m) => this.log(m),
        });
        if (!result.ok) {
          this.error(
            'host CLI `turbo build` failed — resolve the error above, then re-run ' +
              '(the ss binary needs its own dist/ to continue).',
          );
        }
        this.log('  ✓ soa saga-stack-cli dist rebuilt — ss commands restored');
      });
    }

    // ── STEP 5: ensure .env ──
    await this.step('5/6 ensure .env — scaffold missing .env from .env.example', async () => {
      const result = ensureEnv(repos, {
        fs: this.getEnvFs(),
        dryRun: dry,
        notify: (m) => this.log(m),
      });
      const scaffolded = result.results.filter((r) => r.action === 'scaffolded');
      const present = result.results.filter((r) => r.action === 'present');
      this.log(
        `    ${present.length} .env already present, ${scaffolded.length} ${dry ? 'would be' : ''} scaffolded from .env.example`,
      );
      if (scaffolded.length > 0 && !dry) {
        this.log(`✓ scaffolded ${scaffolded.length} .env file(s) — REVIEW their values before the tutorial`);
      }
      // NOTE: this only covers repos that SHIP a .env.example. Any service whose .env is
      // gitignored with no template must still be created by hand (see cold-start.md).
    });

    // ── STEP 6: up --reset --seed → verify ──
    if (dry) {
      this.log('▶ 6/6 up + verify — SKIPPED (dry run)');
      this.log(`    would run: ss stack up --reset --seed ${flags.seed} && ss stack verify`);
      this.log('\n✓ cold-start dry run complete — no changes made.');
      return;
    }

    await this.step(`6/6 up — fresh mesh + provision + migrate + launch + seed ${flags.seed}`, () =>
      StackUp.run(['--reset', '--seed', flags.seed, ...ws], this.config),
    );
    await this.step('6/6 verify — assert every service is green + the roster seeded', () =>
      StackVerify.run([...ws], this.config),
    );

    this.log("✓ cold-start complete — you're on a clean, seeded synthetic-dev baseline on main.");
  }

  /** Run one chain step, logging a pointed failure line and re-throwing so the exit code propagates. */
  private async step(label: string, fn: () => Promise<unknown>): Promise<void> {
    this.log(`▶ ${label}`);
    try {
      await fn();
    } catch (err) {
      this.log(`✗ step failed: ${label} — resolve the above, then re-run.`);
      throw err;
    }
  }

  /** Reconstruct the workspace argv (`--dev` + per-repo pins + `--state-dir`) for the native sub-commands. */
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
