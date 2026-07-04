/**
 * `saga-stack set list` — enumerate the worktree sets (M13-A, plan §2.4).
 *
 * One row per set from `$SAGA_STACK_SETS ?? ~/.saga-stack/worktree-sets.json`:
 * name, slot, ACTIVE, repos, note. ACTIVE is DERIVED LIVE (state-dir pid
 * liveness OR running `soa-s<N>` compose containers — no active.json write
 * path, nothing to go stale). Read-only.
 *
 *   node bin/dev.js set list
 *   node bin/dev.js set list --output-json
 */

import { BaseCommand } from '../../base-command.js';
import { deriveInstance } from '../../core/derive-instance.js';
import type { SetRepoKey, WorktreeSet } from '../../core/set/index.js';
import { makeSlotActiveProbe } from '../../runtime/index.js';
import type { SlotActiveProbe } from '../../runtime/index.js';

export default class SetList extends BaseCommand {
  static description =
    'List the worktree sets (name, slot, live ACTIVE state, repos) from the sets file (read-only).';

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --output-json'];

  static flags = {
    ...BaseCommand.baseFlags,
  };

  /**
   * The injectable slot-activity probe — tests spy this on the prototype to
   * pin ACTIVE without fs/docker, mirroring `getRunner`/`getSetStore`.
   */
  protected getSlotActiveProbe(): SlotActiveProbe {
    return makeSlotActiveProbe();
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SetList);
    const store = this.getSetStore();
    const file = store.load();
    const sets = Object.values(file.sets).sort((a, b) => a.slot - b.slot);

    const probe = this.getSlotActiveProbe();
    const rows = await Promise.all(
      sets.map(async (set) => {
        const profile = deriveInstance({ slot: set.slot });
        return {
          set,
          active: await probe.isActive(profile.stateDir, profile.project),
        };
      }),
    );

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          rows.map(({ set, active }) => ({
            name: set.name,
            slot: set.slot,
            active,
            repos: repoSummary(set),
            ...(set.note !== undefined ? { note: set.note } : {}),
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (rows.length === 0) {
      if (!flags.porcelain) {
        this.log(`No worktree sets defined in ${store.path()}.`);
        this.log('  Define one: {"version":1,"sets":{"my-set":{"slot":1,"repos":{"saga-dash":"~/dev/worktrees/…"}}}}');
      }
      return;
    }

    if (flags.porcelain) {
      for (const { set, active } of rows) {
        this.log(`${set.name}\t${set.slot}\t${active ? 'active' : '-'}\t${repoSummary(set).join(',')}`);
      }
      return;
    }

    const nameW = Math.max(4, ...rows.map(({ set }) => set.name.length));
    this.log(`${'NAME'.padEnd(nameW)}  SLOT  ACTIVE  REPOS`);
    this.log('─'.repeat(nameW + 40));
    for (const { set, active } of rows) {
      const repos = repoSummary(set).join(', ');
      const note = set.note !== undefined ? `  (${set.note})` : '';
      this.log(`${set.name.padEnd(nameW)}  ${String(set.slot).padEnd(4)}  ${(active ? '● up' : '—').padEnd(6)}  ${repos}${note}`);
    }
  }
}

/** The set's pinned repos, kebab names in file order. */
function repoSummary(set: WorktreeSet): SetRepoKey[] {
  return Object.keys(set.repos) as SetRepoKey[];
}
