/**
 * `saga-stack stack reset` — truncate the data DBs to an empty baseline + re-seed
 * the dev user (M8 R4 — NATIVE by default; `--legacy` wraps up.sh --reset).
 *
 * NATIVE (default): the in-process facade (`StackApi.reset`) truncates every
 * closure data DB PRESERVING `_prisma_migrations` (so no re-migrate), migrate-resets
 * ledger_local (drop + remigrate), drops connectv3 (connect mongo), then re-seeds
 * the dev user through the existing seed path. Slot-aware — targets the slot's
 * postgres/connect-mongo containers.
 *
 * `--legacy`: the non-destructive bash escape — routes to `up.sh --reset`
 * (`+ --with-playback` to also truncate the opt-in playback DBs). Kept indefinitely
 * per the plan's non-destructive guarantee.
 *
 * up.sh's reset always truncates every NON-optional data DB; the only opt-in axis
 * is the playback trio (transcripts/insights/chat) — only `--with playback`
 * truncates them, reproducing the old `--with-playback` boolean.
 *
 *   node bin/dev.js stack reset
 *   node bin/dev.js stack reset --with playback
 *   node bin/dev.js stack reset --legacy
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { BUNDLE_NAMES, effectiveWithPlayback } from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { makeStackApi } from '../../stack-api.js';

export default class StackReset extends BaseCommand {
  static description =
    'Truncate the data DBs to an empty baseline + re-seed the dev user (native; --legacy wraps up.sh --reset).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --with playback',
    '<%= config.bin %> <%= command.id %> --legacy',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) whose DBs join the reset set — sugar shared with `stack up`. Only `--with playback` changes the set (it also truncates the opt-in playback DBs — transcripts, insights, chat = the old --with-playback); every other bundle's DBs are already reset by default. Repeatable: --with playback.",
    }),
    legacy: Flags.boolean({
      default: false,
      description:
        'route to the bash `up.sh --reset` (the non-destructive escape) instead of the native runner.',
    }),
  };

  /** M8 R4: the native reset targets the slot's own containers, so it is slot-aware. */
  protected slotAware(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackReset);
    const withPlayback = effectiveWithPlayback(flags.with);

    const profile = deriveInstance({ slot: flags.slot });
    const api = makeStackApi(manifest, this.buildNativeRuntime(flags, profile));

    // The reset set = every non-optional service's DBs (+ playback under
    // --with playback), MINUS the slot-excluded literal-port services (whose DBs
    // live on slot 0). At slot 0 nothing is excluded, so the full default set is reset.
    const requested = (Object.values(manifest.services) as { id: ServiceId; optional: boolean }[])
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const excluded = new Set(profile.excludedServices);
    const services = computeClosure(manifest, requested, { withPlayback }).services.filter(
      (id) => !excluded.has(id),
    );

    const res = await api.reset(services, { legacy: flags.legacy, withPlayback });

    if (res.delegated) {
      this.emit(
        flags,
        { native: false, legacy: true, code: res.code },
        `reset delegated to up.sh --reset (exit ${res.code})`,
      );
      if (res.code !== 0) this.exit(res.code);
      return;
    }

    const truncated = res.native?.dbs.filter((d) => d.action === 'truncated').map((d) => d.db) ?? [];
    const migrateReset = res.native?.dbs.filter((d) => d.action === 'migrate-reset').map((d) => d.db) ?? [];
    const migrateResetFailed =
      res.native?.dbs.filter((d) => d.action === 'migrate-reset' && !d.ok).map((d) => d.db) ?? [];
    const mongo = res.native?.dbs.filter((d) => d.action === 'mongo-dropped').map((d) => d.db) ?? [];
    // Probe-skipped DBs: a not-yet-provisioned DB (e.g. coach_api after a partial `up`)
    // is skipped rather than errored — surfaced so the tolerance is visible, exit unaffected.
    const skippedAbsent =
      res.native?.dbs.filter((d) => d.action === 'skipped' && d.reason === 'not provisioned').map((d) => d.db) ??
      [];

    this.emit(
      flags,
      {
        native: true,
        slot: profile.slot,
        ok: res.code === 0,
        truncated: truncated.join(','),
        migrateReset: migrateReset.join(','),
        migrateResetFailed: migrateResetFailed.join(','),
        mongoDropped: mongo.join(','),
        skippedAbsent: skippedAbsent.join(','),
        devUserReseeded: res.seed?.ok ?? false,
      },
      [
        `native reset (slot ${profile.slot}): ${res.code === 0 ? 'OK' : 'had failures'}`,
        `truncated (kept _prisma_migrations): ${truncated.join(', ') || '(none)'}`,
        // DIVERGENCE from up.sh (which SPARES ledger_local): native reset wipes it
        // via migrate-reset (drop + remigrate to head, no seed) — more thorough than
        // up.sh, and distinct from the truncated set above. Surfaced by decision.
        ...(migrateReset.length
          ? [`migrate-reset (drop + remigrate, up.sh spares this): ${migrateReset.join(', ')}`]
          : []),
        // A migrate-reset failure is WARN-only on the exit code (parity with up.sh's
        // always-0 reset) — but still surface it so a ledger hiccup is never silent.
        ...(migrateResetFailed.length
          ? [`⚠ migrate-reset FAILED (warn-only, exit unaffected): ${migrateResetFailed.join(', ')}`]
          : []),
        ...(mongo.length ? [`mongo dropped: ${mongo.join(', ')}`] : []),
        // A not-yet-provisioned DB (partial `up`) is skipped, not failed — parity with up.sh.
        ...(skippedAbsent.length ? [`skipped (not provisioned): ${skippedAbsent.join(', ')}`] : []),
        `dev-user re-seed: ${res.seed ? (res.seed.ok ? 'OK' : 'FAILED') : '(skipped — iam-api not in set)'}`,
      ],
    );

    if (res.code !== 0) this.exit(1);
  }
}
