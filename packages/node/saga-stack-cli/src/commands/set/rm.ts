/**
 * `saga-stack set rm <name>` — remove a worktree set (M13-C, plan §5). By default this
 * only drops the set from `~/.saga-stack/worktree-sets.json` (the worktrees on disk are
 * left untouched — non-destructive). With `--and-worktrees` it ALSO `git worktree
 * remove`s the worktrees, but ONLY the ones `ss set create` made (`createdBy: 'ss'`) —
 * a hand-recorded path (your own checkout / a worktree you made) is never removed.
 *
 * Removing worktrees is destructive, so `--and-worktrees` requires `--yes`; a dirty or
 * locked worktree needs `--force` (passed straight to `git worktree remove`).
 *
 *   ss set rm sched                      # drop the set entry only
 *   ss set rm sched --and-worktrees --yes   # also remove the ss-created worktree(s)
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { resolveSet, withSetRemoved, type SetRepoKey } from '../../core/set/index.js';
import { REPO_DEFAULT_DIR, REPO_ENV_VAR, resolveDevRoot } from '../../runtime/index.js';

export default class SetRm extends BaseCommand {
  static description =
    'Remove a worktree set from the sets file. --and-worktrees also `git worktree remove`s the ss-created worktrees (createdBy: ss); hand-recorded paths are never touched.';

  static examples = [
    '<%= config.bin %> <%= command.id %> sched',
    '<%= config.bin %> <%= command.id %> sched --and-worktrees --yes',
  ];

  static args = {
    name: Args.string({ description: 'set name (see `set list`)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    'and-worktrees': Flags.boolean({
      description: 'also `git worktree remove` the worktrees ss created (createdBy: ss); requires --yes',
      default: false,
    }),
    force: Flags.boolean({ description: 'pass --force to `git worktree remove` (a dirty/locked worktree)', default: false }),
    yes: Flags.boolean({ description: 'confirm the destructive --and-worktrees removal (required with it)', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetRm);
    const name = args.name;

    const store = this.getSetStore();
    let set;
    try {
      set = resolveSet(store.load(), name); // load() ⇒ expanded paths for git worktree remove
    } catch (err) {
      return this.error((err as Error).message);
    }

    if (flags['and-worktrees']) {
      if (!flags.yes) {
        return this.error('--and-worktrees removes worktrees from disk — re-run with --yes to confirm.');
      }
      const ctx = this.scriptContextFromFlags(flags);
      const git = this.getGitRunner();
      for (const repo of Object.keys(set.repos) as SetRepoKey[]) {
        const entry = set.repos[repo];
        if (entry === undefined) continue;
        if (entry.createdBy !== 'ss') {
          this.log(`  · ${repo.padEnd(12)} left as-is (not ss-created): ${entry.path}`);
          continue;
        }
        const primary = `${resolveDevRoot(ctx).replace(/\/+$/, '')}/${REPO_DEFAULT_DIR[REPO_ENV_VAR[repo]]}`;
        const removed = await git.worktreeRemove(primary, entry.path, { force: flags.force });
        if (removed.ok) {
          this.log(`  ✓ ${repo.padEnd(12)} worktree removed: ${entry.path}`);
        } else {
          this.log(`  ✗ ${repo.padEnd(12)} git worktree remove failed: ${removed.stderr || '(no output)'}${flags.force ? '' : ' — retry with --force if dirty'}`);
        }
      }
    }

    // Drop the set from the file (loadRaw ⇒ other sets' verbatim `~` paths survive).
    store.save(withSetRemoved(store.loadRaw(), name).file);
    this.log(`✓ set '${name}' removed${flags['and-worktrees'] ? '' : ' (worktrees left on disk — use --and-worktrees to remove them too)'}`);
  }
}
