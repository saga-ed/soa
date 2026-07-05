/**
 * Service bundles — named convenience features that are pure SUGAR over `--only`
 * (saga-ed/soa#214).
 *
 * A `--with <bundle>` flag unions a bundle's service-ids into the requested set
 * and then the normal `computeClosure` runs — it is NOT a gate and adds no
 * opt-in logic of its own. A bundle may also carry a SEED add-on (`playback`
 * seeds the playback DBs; `qtf` is seed-only). `stack up`, `stack status`, and
 * `stack verify` all share this module so they honour `--with` identically.
 *
 * SINGLE SOURCE OF TRUTH: `BUNDLES` — every derived shape (`BUNDLE_NAMES`,
 * `SERVICE_BUNDLES`, `BUNDLE_SEED_ADDONS`) and helper is computed from it.
 *
 * PURE: this module carries zero IO.
 */

import type { ServiceId } from './manifest/index.js';

/** The named features a `--with` value may select (services, a seed add-on, or both). */
export type BundleName = 'dash' | 'connect' | 'coach' | 'playback' | 'qtf';

/** A seed add-on a bundle may layer onto the composed seed plan. */
export type BundleSeedAddOn = 'playback' | 'qtf';

/** One bundle: the services it contributes to the closure, its optional seed add-on, and a one-line blurb. */
export interface BundleDef {
  /** Service-ids unioned into the requested set (`[]` for a seed-only feature like qtf). */
  services: readonly ServiceId[];
  /** Seed add-on layered onto the seed plan when this feature is selected (independent of services). */
  seedAddOn?: BundleSeedAddOn;
  /** Brief human description (shown by `stack bundle list`). */
  description: string;
}

/**
 * The bundle registry — the ONE source of truth. A feature may contribute
 * services (`dash`/`connect`/`coach`/`playback`), a seed add-on (`playback`/
 * `qtf`), or both. `playback`'s services are the three `optional:true` APIs, so
 * they only resolve when the closure's `withPlayback` is set (see
 * `effectiveWithPlayback`). `qtf` is seed-only (no services).
 */
export const BUNDLES: Readonly<Record<BundleName, BundleDef>> = {
  dash: {
    services: ['saga-dash'],
    description: 'saga-dash teacher SPA + its full journey backend (closure).',
  },
  connect: {
    services: ['connect-api', 'connect-web'],
    description: 'Connect live-session SPA + API (pulls in iam/sessions/content).',
  },
  coach: {
    services: ['coach-api', 'coach-web'],
    description: 'Coach tutor-PD SPA + API (+ the coach_api DB).',
  },
  playback: {
    services: ['transcripts-api', 'insights-api', 'chat-api'],
    seedAddOn: 'playback',
    description: 'Optional playback/observability APIs (transcripts, insights, chat) + their seed.',
  },
  qtf: {
    services: [],
    seedAddOn: 'qtf',
    description: 'Seed-only: QTF observation-notes demo on an Ended session (no extra services).',
  },
};

/** The valid feature names (registry keys) — feeds oclif's `options` for `--with`. */
export const BUNDLE_NAMES = Object.keys(BUNDLES) as BundleName[];

/** Derived: bundle → service-ids (service-only view of `BUNDLES`). */
export const SERVICE_BUNDLES: Readonly<Record<BundleName, readonly ServiceId[]>> = Object.freeze(
  Object.fromEntries(BUNDLE_NAMES.map((n) => [n, BUNDLES[n].services])) as Record<
    BundleName,
    readonly ServiceId[]
  >,
);

/** Derived: bundle → seed add-on, for the bundles that carry one. */
export const BUNDLE_SEED_ADDONS: Partial<Record<BundleName, BundleSeedAddOn>> = Object.freeze(
  Object.fromEntries(
    BUNDLE_NAMES.filter((n) => BUNDLES[n].seedAddOn).map((n) => [n, BUNDLES[n].seedAddOn]),
  ) as Partial<Record<BundleName, BundleSeedAddOn>>,
);

/**
 * Union the given bundle names into their service-ids, deduped and ordered by
 * bundle-registry declaration order (so `--with coach --with dash` and
 * `--with dash --with coach` yield the same list). A seed-only feature (`qtf`)
 * contributes no services. Calls `fail` (never returns) on an unknown bundle
 * name, listing the valid ones. PURE.
 */
export function expandBundles(names: string[], fail: (msg: string) => never): ServiceId[] {
  const selected = new Set<BundleName>();
  for (const name of names) {
    if (!(name in BUNDLES)) {
      fail(`unknown bundle: ${name}\nvalid bundles: ${BUNDLE_NAMES.join(', ')}`);
    }
    selected.add(name as BundleName);
  }
  const out: ServiceId[] = [];
  const seen = new Set<ServiceId>();
  for (const bundle of BUNDLE_NAMES) {
    if (!selected.has(bundle)) continue;
    for (const id of BUNDLES[bundle].services) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Split a `--only` comma list into trimmed, non-empty service ids. PURE. */
export function parseOnly(only: string | undefined): ServiceId[] {
  if (!only) return [];
  return only
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ServiceId[];
}

/**
 * The requested service set: `parseOnly(only) ∪ expandBundles(with)`, deduped
 * with `--only` ids first (in list order) then the bundle ids (registry order).
 * This is the set fed to `computeClosure`. PURE.
 */
export function combineRequested(
  only: string | undefined,
  withBundles: string[] | undefined,
  fail: (msg: string) => never,
): ServiceId[] {
  const out: ServiceId[] = [];
  const seen = new Set<ServiceId>();
  for (const id of [...parseOnly(only), ...expandBundles(withBundles ?? [], fail)]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Whether the closure should keep the `optional:true` playback services: true
 * iff the `playback` bundle was requested via `--with`. `computeClosure`
 * (closure.ts) DROPS a requested optional service unless `withPlayback` is set,
 * so `--with playback` must flip this or the playback ids get filtered out. PURE.
 */
export function effectiveWithPlayback(withBundles: string[] | undefined): boolean {
  return (withBundles ?? []).includes('playback');
}

/**
 * The ordered, deduped seed add-ons the `--with` features contribute (via
 * `BUNDLE_SEED_ADDONS`): `--with playback` ⇒ `['playback']`, `--with qtf` ⇒
 * `['qtf']`, `--with playback --with qtf` ⇒ both. Service-only features
 * contribute nothing. PURE. (Callers validate the names via `combineRequested`
 * / oclif `options`, so an unknown value never reaches here.)
 */
export function seedAddOnsFor(withBundles: string[] | undefined): BundleSeedAddOn[] {
  const out: BundleSeedAddOn[] = [];
  for (const name of withBundles ?? []) {
    const addon = BUNDLE_SEED_ADDONS[name as BundleName];
    if (addon && !out.includes(addon)) out.push(addon);
  }
  return out;
}
