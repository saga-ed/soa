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

import type { DbId, MeshId, ServiceId } from './manifest/index.js';

/** The named features a `--with` value may select (services, a seed add-on, or both). */
export type BundleName =
  | 'dash'
  | 'connect'
  | 'coach'
  | 'playback'
  | 'qtf'
  | 'authz'
  | 'staff-admin'
  | 'otel';

/** A seed add-on a bundle may layer onto the composed seed plan. */
export type BundleSeedAddOn = 'playback' | 'qtf' | 'authz';

/** One bundle: the services it contributes to the closure, its optional seed add-on, and a one-line blurb. */
export interface BundleDef {
  /** Service-ids unioned into the requested set (`[]` for a seed-only feature like qtf). */
  services: readonly ServiceId[];
  /**
   * Mesh units this feature brings up DIRECTLY, independent of any service.
   *
   * The closure's mesh is otherwise a union over the closure's SERVICES
   * (closure.ts), which means an infra unit can only be gated by hanging it off
   * an `optional:true` service — the way `openfga` rides on `authz-sync`. That
   * breaks down for a unit wanted by an `optional:false` service (e.g. a local
   * OTLP collector for `programs-api`): declaring it there would start it on
   * every `stack up`, and there is nowhere else to put it.
   *
   * A bundle listing mesh here closes that gap without inventing a second
   * gating concept — `qtf` already proves a bundle can contribute zero services
   * and still be meaningful; this is the same idea one axis over.
   */
  mesh?: readonly MeshId[];
  /** Seed add-on layered onto the seed plan when this feature is selected (independent of services). */
  seedAddOn?: BundleSeedAddOn;
  /** Brief human description (shown by `stack bundle list`). */
  description: string;
}

/**
 * The bundle registry — the ONE source of truth. A feature may contribute
 * services (`dash`/`connect`/`coach`/`playback`), a seed add-on (`playback`/
 * `qtf`), mesh units, or a combination. `playback`'s services are the three
 * `optional:true` APIs, so they resolve only when the closure's `features`
 * select `playback`. `qtf` is seed-only (no services).
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
  authz: {
    services: ['authz-sync'],
    seedAddOn: 'authz',
    description:
      'OpenFGA authz stack: brings up the openfga mesh unit, flips iam-api FGA_ENABLED=true, ' +
      'runs the fga-bootstrap seed step (model + canonical tuples), and starts the authz-sync ' +
      'RabbitMQ consumer. First run bootstraps a fresh store (FGA checks fail closed); rerun ' +
      '`stack up --with authz` once more to pick up the persisted store id.',
  },
  'staff-admin': {
    services: ['staff-admin-bff', 'staff-admin-console'],
    description:
      'Staff-admin console: the staff-only SPA (:8910) + its own BFF (:3011), plus the ' +
      'iam/programs/sis closure they read. Log in with `ss stack login` — the console ' +
      'reads that operator cookie. Impersonate is HIDDEN (the synthetic seed mints no ' +
      'staff:* claims) and the COACH pages 401 (coach-api verifies a janus_session).',
  },
  otel: {
    // The first bundle to use `mesh` rather than contributing infra through a
    // service: an OTLP collector is wanted by `programs-api`, which is
    // `optional:false`, so there is no optional service to hang it off.
    services: [],
    mesh: ['otel-collector'],
    description:
      'Local OTLP collector (:4318) that prints received spans to its container log — ' +
      'so a span-level change is verifiable on a laptop instead of first in a deployed ' +
      'environment. Services already default to localhost:4318, so this only gives those ' +
      'exports somewhere to land. `docker logs soa-otel-collector-1` to read them.',
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

// ─── FeatureSet: the variable-arity selection value ───────────────────────────
//
// One value threaded as a unit, replacing a `withX?: boolean` per family — a
// fixed-arity encoding of a variable-arity fact that cost ~70 refs across 13
// files and a hand-sweep to add a family. Because every field was `?:`, a caller
// could pass `{}`, typecheck, and silently resolve an EMPTY closure (exit 0, no
// error); that bug shipped three times. The brand is what forecloses it: `{}`
// and a bare `Set` are not assignable, so only `featureSet()` can mint one and
// "forgot to thread it" is a COMPILE error.

declare const FEATURE_SET_BRAND: unique symbol;

/** The features selected for a run. Mint via `featureSet()` / `featuresFor()`. */
export type FeatureSet = ReadonlySet<BundleName> & { readonly [FEATURE_SET_BRAND]: true };

/**
 * Mint a `FeatureSet`. Dedupes; order is irrelevant (membership-only).
 *
 * The double cast is the standard branded-type hop: the brand exists only in
 * the type system (`declare const`, never assigned at runtime), so a plain
 * `Set` does not structurally satisfy it. Minting is deliberately funnelled
 * through here — that is what stops a caller hand-rolling `new Set()` and
 * bypassing the compile-time guarantee. PURE.
 */
export function featureSet(names: Iterable<BundleName>): FeatureSet {
  return new Set(names) as unknown as FeatureSet;
}

/**
 * `optional:true` service-id → the bundle that admits it, inverted from
 * `BUNDLES` once.
 *
 * Adding a family is a registry edit here with no code change anywhere else —
 * `admitsOptional` and every id→feature consumer read this map.
 *
 * Bundles MAY list `optional:false` ids (`dash`/`connect`/`coach` all do) — those
 * are pure `--only` sugar and need no gate, so a mapping for them is harmless.
 * PURE.
 */
export const BUNDLE_FOR_SERVICE: ReadonlyMap<ServiceId, BundleName> = new Map(
  BUNDLE_NAMES.flatMap((name) =>
    BUNDLES[name].services.map((id) => [id, name] as const),
  ),
);

/**
 * The bundle that admits a database, via its owning service — `undefined` when
 * the db belongs to no bundle (every `meshProvisioned:true` db, which no feature
 * gates).
 *
 * Ownership is only derivable service→db (`svc.databases`), so this walks that
 * direction once and composes with `BUNDLE_FOR_SERVICE`. Callers gating an
 * opt-in db ask `features.has(bundleForDb(...))` rather than hand-listing db ids
 * per family — a hand-list silently mis-gates a db the moment a family gains one.
 *
 * ⚠️ Keyed on OWNERSHIP, never on the db's name or `ownerRole`. `authz_local`
 * is owned by authz-api and is UNCONDITIONAL (a hard sessions-api dep, soa#402);
 * it merely shares a prefix with the `--with authz` OpenFGA opt-in. Callers gate
 * on `meshProvisioned:false`, which excludes it structurally. PURE.
 */
export function bundleForDb(
  db: DbId,
  m: { services: Record<ServiceId, { databases: readonly DbId[] }> },
): BundleName | undefined {
  for (const [id, svc] of Object.entries(m.services) as [
    ServiceId,
    { databases: readonly DbId[] },
  ][]) {
    if (svc.databases.includes(db)) return BUNDLE_FOR_SERVICE.get(id);
  }
  return undefined;
}

/**
 * The features implied by a run's selection flags — from BOTH `--only` and
 * `--with`.
 *
 * 🔑 Deriving from `--only` too is a BUG FIX. `combineRequested` unions both
 * flags into the requested set, but only `--with` ever fed the feature
 * derivation — so `stack up --only transcripts-api` resolved an EMPTY closure
 * (the id was requested, then dropped by `admitsOptional` because nothing
 * admitted it). You had to know to write `--only transcripts-api --with
 * playback`. Naming an optional service now implies its family.
 *
 * No currently-working invocation changes meaning: this only ADMITS ids that
 * were previously dropped. PURE.
 */
export function featuresFor(
  only: string | undefined,
  withBundles: string[] | undefined,
  fail: (msg: string) => never,
): FeatureSet {
  const named: BundleName[] = [];
  for (const name of withBundles ?? []) {
    if (!(name in BUNDLES)) {
      fail(`unknown bundle: ${name}\nvalid bundles: ${BUNDLE_NAMES.join(', ')}`);
    }
    named.push(name as BundleName);
  }
  const implied = parseOnly(only)
    .map((id) => BUNDLE_FOR_SERVICE.get(id))
    .filter((b): b is BundleName => b !== undefined);
  return featureSet([...named, ...implied]);
}

/**
 * The features implied by a set of service-ids already known to be wanted (a
 * workspace run-set, a flow's `requiredSystems`) — the id→feature direction of
 * `featuresFor`, over the same derived map so the two cannot drift. PURE.
 */
export function featuresForIds(ids: readonly ServiceId[]): FeatureSet {
  return featureSet(
    ids.map((id) => BUNDLE_FOR_SERVICE.get(id)).filter((b): b is BundleName => b !== undefined),
  );
}

/**
 * Features from bundle NAMES plus already-resolved service IDS — for callers
 * that have both (a `--with` list and a `requested` array they built earlier).
 *
 * Unknown bundle names are ignored rather than fatal: callers in this shape have
 * already validated their `--with` values while building `requested`
 * (`combineRequested` fails on an unknown name), so re-failing here would be
 * dead code with a second error path to keep in sync. PURE.
 */
export function featuresOf(
  withBundles: string[] | undefined,
  ids: readonly ServiceId[],
): FeatureSet {
  const named = (withBundles ?? []).filter((n): n is BundleName => n in BUNDLES);
  return featureSet([...named, ...featuresForIds(ids)]);
}

/**
 * The `--with` bundle name that contributes a given service id, or `undefined`
 * when no bundle does.
 *
 * For "re-run `ss stack up --with <X>`" advice: the bundle name and the service
 * id are NOT interchangeable (`authz-sync` lives in the `authz` bundle, and the
 * staff-admin pair in `staff-admin`), so a message that prints the id is telling
 * the operator to run a command that fails on an unknown bundle. Derived from
 * `BUNDLES` in registry order, so it cannot drift as families are added. PURE.
 */
export function bundleForService(id: ServiceId): BundleName | undefined {
  return BUNDLE_NAMES.find((name) => BUNDLES[name].services.includes(id));
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
