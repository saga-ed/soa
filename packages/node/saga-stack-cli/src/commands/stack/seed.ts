/**
 * `saga-stack stack seed [profile]` — seed an ALREADY-RUNNING stack (FLIP 2 —
 * fully NATIVE).
 *
 * NATIVE: build the `SeedSelection` (profile + the `--with` seed add-ons),
 * `composeSeedPlan` over the running stack's active service set (the full
 * non-optional closure, + the playback trio under `--with playback`), and run it
 * through `StackApi.seed` — the SAME native seed runner `stack up --only` uses. It
 * seeds a stack whose services are ALREADY up, so there is no prep / mesh / launch:
 * just the offline-then-online seed steps.
 *
 * The optional `profile` arg defaults to `roster` (up.sh's own bare-`--seed`
 * default). A bundle's DATA scope on `seed` is its SEED ADD-ON (`--with playback`
 * ⇒ `playback`; `--with qtf` ⇒ `qtf`) — derived from the shared bundle registry so
 * it cannot drift from `--with`. A bundle with no seed add-on (`--with dash`/
 * `coach`/`connect`) is a harmless no-op here.
 *
 *   node bin/dev.js stack seed
 *   node bin/dev.js stack seed full --with playback
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { BUNDLE_NAMES, combineRequested, effectiveWithPlayback, seedAddOnsFor } from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { composeSeedPlan } from '../../core/seed/compose-seed-plan.js';
import type { SeedAddOn, SeedProfile, SeedSelection } from '../../core/seed/types.js';
import { makeStackApi } from '../../stack-api.js';

export default class StackSeed extends BaseCommand {
  static description = 'Seed a running stack (native).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> full --with playback',
  ];

  static args = {
    profile: Args.string({
      description: 'seed profile to apply',
      options: ['roster', 'full'],
      default: 'roster',
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) whose seed ADD-ON is layered onto the seed plan — sugar shared with `stack up`. Repeatable: --with playback --with qtf. `--with playback` seeds the playback DBs (== the old --with-playback); `--with qtf` seeds the QTF demo. Bundles with no seed add-on (dash/coach/connect) are a no-op here.",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackSeed);
    const profile = args.profile as SeedProfile;

    // A bundle's seed-axis contribution is its seed add-on (derived from the
    // registry so it cannot drift from `--with`): `--with playback` ⇒ playback,
    // `--with qtf` ⇒ qtf.
    const addOns: SeedAddOn[] = [...seedAddOnsFor(flags.with)];

    // ── NATIVE: compose the plan over the RUNNING stack + run it. ──
    // The active set is the full non-optional closure (the running stack) UNIONED
    // with any services a `--with` bundle pulls in — `--with playback` adds the
    // playback trio (transcripts/insights/chat) so their add-on seed steps compose
    // instead of being dropped as service-inactive. There is no prep/mesh/launch —
    // the services are assumed already up.
    const withPlayback = effectiveWithPlayback(flags.with);
    const fullNonOptional = (Object.values(manifest.services) as { id: ServiceId; optional: boolean }[])
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const bundleServices = combineRequested(undefined, flags.with, (m) => this.error(m));
    const requested = [...new Set<ServiceId>([...fullNonOptional, ...bundleServices])];
    const active = new Set(computeClosure(manifest, requested, { withPlayback }).services);

    const selection: SeedSelection = { profile, addOns };
    const plan = composeSeedPlan(selection, active, new Set<ServiceId>());

    const instance = deriveInstance({ slot: flags.slot });
    const api = makeStackApi(manifest, this.buildNativeRuntime(flags, instance));
    const seeded = await api.seed(plan);

    this.emit(
      flags,
      {
        native: true,
        profile,
        addOns,
        ok: seeded.ok,
        offline: seeded.ran.offline,
        online: seeded.ran.online,
        skipped: seeded.skipped.map((s) => ({ id: s.id, reason: s.reason })),
        ...(seeded.failed ? { failed: seeded.failed } : {}),
      },
      [
        `native seed (profile ${profile}${addOns.length ? `, add-ons ${addOns.join(', ')}` : ''}):`,
        `seed offline: ${seeded.ran.offline.join(', ') || '(none)'}`,
        `seed online:  ${seeded.ran.online.join(', ') || '(none)'}`,
        seeded.ok ? 'seed: OK' : `seed: FAILED at ${seeded.failed}`,
      ],
    );

    if (!seeded.ok) this.exit(1);
  }
}
