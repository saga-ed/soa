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
 * MULTI-SEED (#221): `--scenario <name>` applies a named cross-system dataset
 * scenario (e.g. `ab-topology` stamps `SEED_DATASET=ab-topology` onto the
 * programs/scheduling/sessions steps); a repeatable `--dataset <system>=<name>`
 * names one system's dataset directly. `--dry-run` prints the composed plan
 * (with any stamped datasets) without touching the stack.
 *
 *   node bin/dev.js stack seed
 *   node bin/dev.js stack seed full --with playback
 *   node bin/dev.js stack seed full --scenario ab-topology --dry-run
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  BUNDLE_NAMES,
  combineRequested,
  effectiveWithAuthz,
  effectiveWithPlayback,
  seedAddOnsFor,
} from '../../core/bundles.js';
import { computeClosure } from '../../core/closure.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { manifest } from '../../core/manifest/index.js';
import type { ServiceId } from '../../core/manifest/index.js';
import { composeSeedPlan } from '../../core/seed/compose-seed-plan.js';
import { SEED_SCENARIO_NAMES, SeedDatasetError, seedStepLabel } from '../../core/seed/datasets.js';
import type { SeedScenarioName, SystemSeedDataset } from '../../core/seed/datasets.js';
import type { SeedAddOn, SeedPlan, SeedProfile, SeedSelection } from '../../core/seed/types.js';
import { makeStackApi } from '../../stack-api.js';

/** Parse repeatable `--dataset <system>=<name>` values (validated against the manifest). */
export function parseDatasetFlags(
  values: string[] | undefined,
  fail: (msg: string) => never,
): SystemSeedDataset[] | undefined {
  if (!values || values.length === 0) return undefined;
  const known = new Set(Object.keys(manifest.services));
  return values.map((raw) => {
    const eq = raw.indexOf('=');
    const system = eq >= 0 ? raw.slice(0, eq) : '';
    const dataset = eq >= 0 ? raw.slice(eq + 1) : '';
    if (system === '' || dataset === '') {
      fail(`--dataset expects <system>=<name>, got '${raw}'`);
    }
    if (!known.has(system)) {
      fail(`--dataset: unknown service id '${system}'\nknown: ${[...known].join(', ')}`);
    }
    return { system: system as ServiceId, dataset };
  });
}

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
        "convenience bundle(s) whose seed ADD-ON is layered onto the seed plan — sugar shared with `stack up`. Repeatable: --with playback --with qtf --with authz. `--with playback` seeds the playback DBs (== the old --with-playback); `--with qtf` seeds the QTF demo; `--with authz` runs the fga-bootstrap step (OpenFGA store/model bootstrap). Bundles with no seed add-on (dash/coach/connect) are a no-op here.",
    }),
    scenario: Flags.string({
      options: [...SEED_SCENARIO_NAMES],
      description:
        'named cross-system dataset scenario (#221 multi-seed) — stamps SEED_DATASET onto every step of the scenario\'s coupled systems (e.g. ab-topology ⇒ programs/scheduling/sessions), so the coupled dataset is applied together or not at all.',
    }),
    dataset: Flags.string({
      multiple: true,
      description:
        "per-system named dataset (#221 multi-seed), '<system>=<name>' — stamps SEED_DATASET=<name> onto that system's selected seed steps. Repeatable; merges with --scenario (a conflicting name for the same system errors).",
    }),
    'dry-run': Flags.boolean({
      description: 'print the composed seed plan (with any stamped datasets) and exit without seeding.',
    }),
  };

  /** M13-A: seed's runtime is fully slot-parameterized (MESH_PG_PORT + container tokens). */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `stack seed --set <name>` seeds the set's slot. */
  protected setAware(): boolean {
    return true;
  }

  /** Slot claims: seeding rewrites the slot's data — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(StackSeed);
    const profile = args.profile as SeedProfile;
    const instance = deriveInstance({ slot: flags.slot });

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
    const withAuthz = effectiveWithAuthz(flags.with);
    const fullNonOptional = (Object.values(manifest.services) as { id: ServiceId; optional: boolean }[])
      .filter((s) => !s.optional)
      .map((s) => s.id);
    const bundleServices = combineRequested(undefined, flags.with, (m) => this.error(m));
    const requested = [...new Set<ServiceId>([...fullNonOptional, ...bundleServices])];
    // M13-A: at slot > 0 the literal-port services are not running in the slot
    // (SLOT_EXCLUDED_SERVICES) and their DBs are never provisioned there —
    // subtract them from the active set exactly like `reset` does, so their
    // seed steps degrade to service-inactive skips instead of failing.
    const excluded = new Set(instance.excludedServices);
    const closureServices = computeClosure(manifest, requested, { withPlayback, withAuthz }).services;
    const active = new Set(closureServices.filter((id) => !excluded.has(id)));
    const droppedForSlot = closureServices.filter((id) => excluded.has(id));
    if (droppedForSlot.length > 0) {
      this.log(
        `⚠ slot ${instance.slot}: backend sub-stack — excluding literal-port + frontend ` +
          `service(s) from the seed set: ${droppedForSlot.join(', ')}`,
      );
    }

    // #221 multi-seed: scenario + per-system datasets (compose stamps SEED_DATASET
    // onto clones of the selected steps and enforces scenario coherence).
    const datasets = parseDatasetFlags(flags.dataset, (m) => this.error(m));
    const selection: SeedSelection = {
      profile,
      addOns,
      ...(flags.scenario ? { scenario: flags.scenario as SeedScenarioName } : {}),
      ...(datasets ? { datasets } : {}),
    };
    let plan: SeedPlan;
    try {
      plan = composeSeedPlan(selection, active, new Set<ServiceId>());
    } catch (err) {
      if (err instanceof SeedDatasetError) this.error(err.message);
      throw err;
    }

    if (flags['dry-run']) {
      this.emit(
        flags,
        {
          native: true,
          dryRun: true,
          profile,
          addOns,
          ...(flags.scenario ? { scenario: flags.scenario } : {}),
          ...(datasets ? { datasets } : {}),
          offline: plan.offline.map((s) => seedStepLabel(s)),
          online: plan.online.map((s) => seedStepLabel(s)),
          skipped: plan.skipped.map((s) => ({ id: s.id, reason: s.reason })),
        },
        [
          `seed plan (dry-run, profile ${profile}${flags.scenario ? `, scenario ${flags.scenario}` : ''}):`,
          `  offline: ${plan.offline.map((s) => seedStepLabel(s)).join(', ') || '(none)'}`,
          `  online:  ${plan.online.map((s) => seedStepLabel(s)).join(', ') || '(none)'}`,
          `  skipped: ${plan.skipped.map((s) => `${s.id} (${s.reason})`).join(', ') || '(none)'}`,
        ],
      );
      return;
    }

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
