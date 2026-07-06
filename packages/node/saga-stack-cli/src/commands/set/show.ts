/**
 * `saga-stack set show <name>` — one set in full (M13-A, plan §2.4).
 *
 * The entry (slot, note, per-repo path + provenance) plus each repo's LIVE
 * resolved branch (`git -C <path> branch --show-current`) and dirty flag.
 * Read-only. A missing path renders '(missing)' and an existing dir that is
 * not a git checkout renders '(not a git checkout)' (probed via
 * `rev-parse --verify HEAD` — branchShowCurrent alone folds errors to '',
 * which would be indistinguishable from a real detached HEAD).
 *
 *   node bin/dev.js set show journey-fix
 */

import { existsSync } from 'node:fs';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { resolveSet } from '../../core/set/index.js';
import type { SetRepoEntry, SetRepoKey } from '../../core/set/index.js';

export default class SetShow extends BaseCommand {
  static description = 'Show one worktree set: slot, repos, and each repo’s live branch + dirty state (read-only).';

  static examples = ['<%= config.bin %> <%= command.id %> journey-fix'];

  static args = {
    name: Args.string({ description: 'set name (see `set list`)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    fetch: Flags.boolean({
      description:
        'git fetch each repo first so the mainline-currency report reflects the REMOTE tip (network); without it, currency is as-of the last fetch',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetShow);
    let set;
    try {
      set = resolveSet(this.getSetStore().load(), args.name);
    } catch (err) {
      return this.error((err as Error).message);
    }

    const git = this.getGitRunner();
    const repos = await Promise.all(
      (Object.entries(set.repos) as [SetRepoKey, SetRepoEntry][]).map(async ([repo, entry]) => {
        if (!existsSync(entry.path)) {
          return { repo, entry, exists: false, checkout: false, branch: null, dirty: null, mainRef: null, includesMain: null, behindMain: null };
        }
        // branchShowCurrent folds ALL errors to '' — indistinguishable from a
        // real detached HEAD — so probe checkout-ness explicitly first: a dir
        // that is not a git checkout must not render as '@ (detached) (clean)'.
        if (!(await git.revParseVerify(entry.path, 'HEAD'))) {
          return { repo, entry, exists: true, checkout: false, branch: null, dirty: null, mainRef: null, includesMain: null, behindMain: null };
        }
        const branch = (await git.branchShowCurrent(entry.path)) || '(detached)';
        const dirty = (await git.statusPorcelain(entry.path)).trim() !== '';
        // Mainline currency (as-of last fetch unless --fetch): does this
        // worktree already CONTAIN origin/<default>? If not, how far behind?
        if (flags.fetch) await git.fetch(entry.path);
        const mainRef = `origin/${await git.symbolicRefDefault(entry.path)}`;
        let includesMain: boolean | null = null;
        let behindMain: number | null = null;
        if (await git.revParseVerify(entry.path, mainRef)) {
          includesMain = await git.isAncestorOfHead(entry.path, mainRef);
          behindMain = includesMain ? 0 : await git.countBehindRef(entry.path, mainRef); // null = could not compare
        }
        return { repo, entry, exists: true, checkout: true, branch, dirty, mainRef, includesMain, behindMain };
      }),
    );

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          {
            name: set.name,
            slot: set.slot,
            ...(set.note !== undefined ? { note: set.note } : {}),
            repos: repos.map((r) => ({
              repo: r.repo,
              path: r.entry.path,
              exists: r.exists,
              checkout: r.checkout,
              branch: r.branch,
              dirty: r.dirty,
              mainRef: r.mainRef,
              includesMain: r.includesMain,
              behindMain: r.behindMain,
              ...(r.entry.createdBy !== undefined ? { createdBy: r.entry.createdBy } : {}),
              ...(r.entry.createdFrom !== undefined ? { createdFrom: r.entry.createdFrom } : {}),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (flags.porcelain) {
      for (const r of repos) {
        const state = !r.exists ? 'missing' : !r.checkout ? 'not-a-checkout' : (r.branch ?? '');
        this.log(`${r.repo}\t${r.entry.path}\t${state}\t${r.dirty ? 'dirty' : 'clean'}`);
      }
      return;
    }

    this.log(`${set.name} — slot ${set.slot}${set.note !== undefined ? `  (${set.note})` : ''}`);
    for (const r of repos) {
      if (!r.exists) {
        this.log(`  ✗ ${r.repo.padEnd(12)} ${r.entry.path}  (missing)`);
        continue;
      }
      if (!r.checkout) {
        this.log(`  ✗ ${r.repo.padEnd(12)} ${r.entry.path}  (not a git checkout)`);
        continue;
      }
      const provenance = r.entry.createdFrom !== undefined ? `  created from ${r.entry.createdFrom}` : '';
      const currency =
        r.includesMain === null
          ? ''
          : r.includesMain
            ? `  [includes ${r.mainRef}]`
            : `  [⚠ behind ${r.mainRef} by ${r.behindMain ?? '?'} — merge up]`;
      this.log(
        `  ✓ ${r.repo.padEnd(12)} ${r.entry.path}  @ ${r.branch}${r.dirty ? ' (dirty)' : ' (clean)'}${provenance}${currency}`,
      );
    }
  }
}
