/**
 * `saga-stack set check <name>` — validate a worktree set (M13-A/B, plan §2.4).
 *
 * Renders the shared checker (`runtime/set-check.ts` — the SAME evaluation
 * `stack up --set` / `e2e run --set` run implicitly as their preflight):
 * per repo — path existence, git-checkout-ness, buildable vs pre-built (the
 * prep fresh-skip predicate), WARN-only branch drift vs `createdFrom`,
 * primary-checkout posture (tenet 4), and the cross-set build-collision
 * dry-check (sharpened with live ACTIVE-slot detection).
 *
 * Exit 1 iff any violation fired (warnings never affect the exit code).
 *
 *   node bin/dev.js set check journey-fix
 */

import { Args } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { resolveSet } from '../../core/set/index.js';
import { checkWorktreeSet } from '../../runtime/index.js';

export default class SetCheck extends BaseCommand {
  static description =
    'Validate a worktree set: paths, buildable-vs-prebuilt, branch drift (warn), primary-checkout posture, cross-set build collisions. Exit 1 on violations.';

  static examples = ['<%= config.bin %> <%= command.id %> journey-fix'];

  static args = {
    name: Args.string({ description: 'set name (see `set list`)', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SetCheck);
    const file = this.getSetStore().load();
    let set;
    try {
      set = resolveSet(file, args.name);
    } catch (err) {
      return this.error((err as Error).message);
    }

    const result = await checkWorktreeSet(set, file.sets, {
      git: this.getGitRunner(),
      isPrebuilt: this.getPrepFreshCheck(),
      devRoot: flags.dev ?? '',
      activeProbe: this.getSlotActiveProbe(),
    });

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          { name: set.name, slot: set.slot, repos: result.repos, ok: result.violationCount === 0 },
          null,
          2,
        ),
      );
      if (result.violationCount > 0) this.exit(1);
      return;
    }

    if (!flags.porcelain) this.log(`${set.name} — slot ${set.slot}`);
    for (const c of result.repos) {
      if (flags.porcelain) {
        this.log(`${c.repo}\t${c.violations.length === 0 ? 'ok' : 'violation'}\t${c.warnings.length}`);
        continue;
      }
      if (c.branch === null) {
        this.log(`  ✗ ${c.repo.padEnd(12)} ${c.violations[0]}`);
        continue;
      }
      const posture = c.prebuilt ? 'pre-built' : 'buildable';
      this.log(`  ${c.violations.length ? '✗' : '✓'} ${c.repo.padEnd(12)} ${c.path}  @ ${c.branch} (${posture})`);
      for (const v of c.violations) this.log(`      ✗ ${v}`);
      for (const w of c.warnings) this.log(`      ⚠ ${w}`);
    }
    if (!flags.porcelain) {
      this.log(
        result.violationCount === 0
          ? `✓ ${set.name}: OK (sets are backend+dash contexts at slot>0 — connect stays on slot 0)`
          : `✗ ${set.name}: ${result.violationCount} violation(s)`,
      );
    }
    if (result.violationCount > 0) this.exit(1);
  }
}
