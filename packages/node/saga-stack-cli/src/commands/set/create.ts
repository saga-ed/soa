/**
 * `saga-stack set create <name>` — the M13-C concierge for a worktree set (plan §5,
 * saga-ed/soa#214). Collapses the hand-managed 8b flow — `git worktree add` +
 * hand-edit `~/.saga-stack/worktree-sets.json` — into one command:
 *
 *   1. `git -C <primary> worktree add [-b <branch>] <path> [<base>]` off the repo's
 *      PRIMARY checkout (`<dev>/<default-dir>`), attaching an existing `--branch` or
 *      creating a new one (default: the set name);
 *   2. best-effort `pnpm install` in the new worktree (satisfies the prep fresh-skip
 *      guard so `--set` up/e2e don't rebuild from cold) — skip with `--no-install`;
 *   3. record the set in the sets file with `createdBy: 'ss'` + `createdFrom: <branch>`
 *      (the provenance that later gates `set rm --and-worktrees` and powers the drift
 *      report in `set check`).
 *
 * SLOT-AWARE so `--slot 1..9` (the slot the set binds) passes the central guard; the
 * set OWNS its slot, so the write is refused if that slot is already taken. Single-repo
 * per invocation (the common case — most sets pin one repo); multi-repo sets stay
 * hand-editable.
 *
 *   ss set create sched --slot 1 --repo saga-dash --path ~/dev/worktrees/saga-dash-sched --branch feat/sched
 */

import { Args, Flags } from '@oclif/core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { BaseCommand } from '../../base-command.js';
import {
  SET_REPO_KEYS,
  withSetAdded,
  type SetRepoKey,
  type WorktreeSet,
} from '../../core/set/index.js';
import {
  REPO_DEFAULT_DIR,
  REPO_ENV_VAR,
  normalizeSetPath,
  resolveDevRoot,
} from '../../runtime/index.js';

export default class SetCreate extends BaseCommand {
  static description =
    'Create a worktree set: git worktree add (new/existing branch) off the primary checkout, pnpm install, and record it in the sets file (createdBy: ss). Single repo per call.';

  static examples = [
    '<%= config.bin %> <%= command.id %> sched --slot 1 --repo saga-dash --path ~/dev/worktrees/saga-dash-sched --branch feat/sched',
    '<%= config.bin %> <%= command.id %> topo --slot 2 --repo saga-dash --path ~/dev/worktrees/saga-dash-topo --branch flow/topology --no-install',
  ];

  static args = {
    name: Args.string({ description: 'set name (must be unused)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    slot: Flags.integer({
      description: 'slot the set binds (1..9; slot 0 is the primary-checkout baseline)',
      required: true,
    }),
    repo: Flags.string({
      description: 'repo to make a worktree for',
      options: [...SET_REPO_KEYS],
      required: true,
    }),
    path: Flags.string({ description: 'worktree checkout path (recorded verbatim; `~` stays portable)', required: true }),
    branch: Flags.string({ description: 'branch to check out — created if new, attached if it exists (default: the set name)' }),
    base: Flags.string({ description: 'start point for a NEW branch (default: the primary checkout HEAD, e.g. main)' }),
    note: Flags.string({ description: 'optional note stored on the set' }),
    install: Flags.boolean({
      description: 'pnpm install in the new worktree so `--set` up/e2e fresh-skip (use --no-install to skip)',
      default: true,
      allowNo: true,
    }),
  };

  // `--slot 1..9` is data (the slot the set binds), not a run-target — opt past the guard.
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetCreate);
    const name = args.name;
    const repo = flags.repo as SetRepoKey;

    if (flags.slot < 1 || flags.slot > 9) {
      return this.error(`--slot must be 1..9 (slot 0 is the primary-checkout baseline); got ${flags.slot}.`);
    }

    const store = this.getSetStore();
    const file = store.loadRaw();
    // Fail BEFORE touching git if the name/slot are taken (withSetAdded's guards).
    for (const [n, s] of Object.entries(file.sets)) {
      if (n === name) return this.error(`a set named '${name}' already exists — pick another name or \`ss set rm ${name}\` first.`);
      if (s.slot === flags.slot) return this.error(`slot ${flags.slot} is already owned by set '${n}' — pick another slot (1..9).`);
    }

    // Primary checkout of the repo (`<dev>/<default-dir>`) — the clone worktrees branch off.
    const ctx = this.scriptContextFromFlags(flags);
    const primary = `${resolveDevRoot(ctx).replace(/\/+$/, '')}/${REPO_DEFAULT_DIR[REPO_ENV_VAR[repo]]}`;
    if (!existsSync(`${primary}/.git`)) {
      return this.error(`primary checkout for '${repo}' not found at ${primary} — clone it first (or pass --dev).`);
    }

    // Expand the worktree path for the fs/git ops; STORE it verbatim (portable `~`).
    const expanded = normalizeSetPath(flags.path, homedir(), dirname(store.path()));
    if (existsSync(expanded)) {
      return this.error(`worktree path already exists: ${expanded} — remove it or choose another --path.`);
    }

    const git = this.getGitRunner();
    const branch = flags.branch ?? name;
    const branchExists = await git.revParseVerify(primary, `refs/heads/${branch}`);

    this.log(`▶ git worktree add ${expanded} ${branchExists ? `(attach ${branch})` : `(-b ${branch}${flags.base ? ` from ${flags.base}` : ''})`}`);
    const added = await git.worktreeAdd(primary, expanded, branch, {
      newBranch: !branchExists,
      startPoint: branchExists ? undefined : flags.base,
    });
    if (!added.ok) {
      return this.error(`git worktree add failed for ${repo}: ${added.stderr || '(no git output)'}`);
    }

    // Best-effort install so the prep fresh-skip guard is satisfied (8b).
    if (flags.install) {
      this.log(`▶ pnpm install in ${expanded} (skip with --no-install)`);
      const res = await this.getRunner().run({ cwd: expanded, command: 'pnpm', args: ['install'], env: {}, stdio: 'inherit' });
      if (res.code !== 0) this.log(`⚠ pnpm install exited ${res.code} — the worktree exists; install it by hand before \`--set ${name}\``);
    }

    // Record the set (verbatim path + provenance) and persist.
    const entry = { path: flags.path, createdBy: 'ss' as const, createdFrom: branch };
    const set: WorktreeSet = {
      name,
      slot: flags.slot,
      repos: { [repo]: entry } as Partial<Record<SetRepoKey, typeof entry>>,
      ...(flags.note !== undefined ? { note: flags.note } : {}),
    };
    store.save(withSetAdded(file, set));

    this.log(`✓ set '${name}' → slot ${flags.slot}, ${repo} @ ${branch}`);
    this.log(`  next: ss set check ${name}  ·  ss stack up --set ${name}  ·  ss e2e run --set ${name} <flow>`);
  }
}
