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

import type { ClosureOpts } from './closure.js';
import type { MeshId, ServiceId } from './manifest/index.js';

/** The named features a `--with` value may select (services, a seed add-on, or both). */
export type BundleName =
  | 'dash'
  | 'connect'
  | 'coach'
  | 'playback'
  | 'qtf'
  | 'authz'
  | 'staff-admin';

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
 * Whether the closure should keep the `optional:true` `authz-sync` service AND
 * iam-api should get FGA_ENABLED=true + the openfga mesh unit: true iff the
 * `authz` bundle was requested via `--with`. Same shape as
 * `effectiveWithPlayback` — `computeClosure` drops `authz-sync` unless this is
 * set, and `defaultLaunchContext`/`resolveLaunchEnv` use it to gate iam-api's
 * FGA_ENABLED token and the `openfga` mesh unit's inclusion, keeping the
 * OpenFGA footprint opt-in rather than part of every default `stack up`. PURE.
 */
export function effectiveWithAuthz(withBundles: string[] | undefined): boolean {
  return (withBundles ?? []).includes('authz');
}

/**
 * Whether the closure should keep the `optional:true` staff-admin pair
 * (`staff-admin-bff` + `staff-admin-console`): true iff the `staff-admin`
 * bundle was requested via `--with`. Same shape as `effectiveWithAuthz` —
 * `computeClosure` drops both unless this is set, keeping the operator console
 * out of every default `stack up`. PURE.
 */
export function effectiveWithStaffAdmin(withBundles: string[] | undefined): boolean {
  return (withBundles ?? []).includes('staff-admin');
}

// ─── FeatureSet: the variable-arity replacement for the per-family booleans ───
//
// `ClosureOpts` carries one `withX?: boolean` per optional-service family. That
// is a fixed-arity encoding of a variable-arity fact, and it costs: ~70 refs
// across 13 files, a hand-sweep to add a family, and — because every field is
// `?:` — a caller can pass `{}`, typecheck, and silently resolve an EMPTY
// closure (exit 0, no error). That bug has shipped three times.
//
// A `FeatureSet` is one value threaded as a unit. The brand is what
// `Required<Pick<…>>` was doing: it makes "forgot to thread it" a COMPILE error
// instead of a silent empty stack, because `{}` and a bare `Set` are not
// assignable to it — only `featureSet()` can mint one.

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
 * Replaces the hand-listed `PLAYBACK_IDS`/`AUTHZ_IDS`/`STAFF_ADMIN_IDS` trio and
 * the three-branch `if` in `admitsOptional`: adding a family becomes a registry
 * edit with no code change anywhere else.
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
 * The features implied by a run's selection flags — from BOTH `--only` and
 * `--with`.
 *
 * 🔑 Deriving from `--only` too is a BUG FIX. `combineRequested` unions the two
 * flags into the requested set, but only `--with` fed the old
 * `closureOptsFor` — so `stack up --only transcripts-api` resolved an EMPTY
 * closure (the id was requested, then dropped by `admitsOptional` because no
 * flag admitted it). You had to know to write `--only transcripts-api --with
 * playback`. Now naming an optional service implies its family.
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
 * The `optional:true` service ids each opt-in flag admits, derived from the
 * bundle registry so they cannot drift from `BUNDLES`.
 *
 * Consumers that must map an optional id BACK to its flag (flow resolution,
 * workspace run-sets) use these instead of hand-listing ids — every optional
 * service needs its OWN flag (see `admitsOptional`), and a stale hand-list is
 * exactly how one gets silently dropped into an empty closure.
 */
export const PLAYBACK_IDS: readonly ServiceId[] = BUNDLES.playback.services;
export const AUTHZ_IDS: readonly ServiceId[] = BUNDLES.authz.services;
export const STAFF_ADMIN_IDS: readonly ServiceId[] = BUNDLES['staff-admin'].services;

/**
 * The fully-resolved opt-in flags for every `optional:true` family — one field
 * per flag, none omittable.
 *
 * `Required` is load-bearing: every `ClosureOpts` field is declared `?:`, so a
 * bare `Pick` would leave them all optional and a caller could pass `{}` — which
 * typechecks and then silently resolves an EMPTY closure (exit 0, no error). The
 * alias exists so adding a fourth family is ONE edit here rather than a hand-sweep
 * of every signature that spells the shape out.
 */
export type ResolvedClosureOpts = Required<
  Pick<ClosureOpts, 'withPlayback' | 'withAuthz' | 'withStaffAdmin'>
>;

/**
 * Every optional-service opt-in flag, derived from one `--with` list.
 *
 * THE point of this helper: each `optional:true` family needs its OWN flag, and
 * every flag defaults to FALSE — so a `computeClosure` caller that forgets one
 * silently resolves an EMPTY closure (exit 0, no error, no compiler help). That
 * failure has now been shipped three times (snapshot store, snapshot restore,
 * flow resolution). Deriving all flags in ONE place means adding a bundle is a
 * single edit here rather than a hand-sweep of every call site.
 *
 * Returns a `Required<…>` shape so a caller cannot partially spread it. PURE.
 */
export function closureOptsFor(
  withBundles: string[] | undefined,
): ResolvedClosureOpts {
  return {
    withPlayback: effectiveWithPlayback(withBundles),
    withAuthz: effectiveWithAuthz(withBundles),
    withStaffAdmin: effectiveWithStaffAdmin(withBundles),
  };
}

/**
 * The opt-in flags implied by a set of service ids already known to be wanted
 * (a workspace run-set, a flow's `requiredSystems`) — the id→flag direction of
 * `closureOptsFor`. Derived from the same `BUNDLES`-backed id sets, so it cannot
 * drift. PURE.
 */
export function closureOptsForIds(
  ids: readonly ServiceId[],
): ResolvedClosureOpts {
  const has = (family: readonly ServiceId[]): boolean => ids.some((id) => family.includes(id));
  return {
    withPlayback: has(PLAYBACK_IDS),
    withAuthz: has(AUTHZ_IDS),
    withStaffAdmin: has(STAFF_ADMIN_IDS),
  };
}

// ─── Legacy adapters (TEMPORARY — delete with the last `withX` call site) ─────
//
// These bridge the boolean-per-family world to `FeatureSet` so the ~64
// pass-through sites keep compiling while the ~6 producers convert. They are
// the ONLY thing that should reference both shapes; once the pass-throughs are
// converted, `toLegacy`/`fromLegacy`, `ResolvedClosureOpts`, `effectiveWithX`
// and the `*_IDS` exports all go together.
//
// ⚠️ Do not delete these before every pass-through is converted — a half-
// converted site would silently fall back to a default-false flag, which is
// exactly the empty-closure failure this refactor exists to kill.

/** `FeatureSet` → the legacy three-boolean shape. PURE. */
export function toLegacy(features: FeatureSet): ResolvedClosureOpts {
  return {
    withPlayback: features.has('playback'),
    withAuthz: features.has('authz'),
    withStaffAdmin: features.has('staff-admin'),
  };
}

/** Legacy flags → `FeatureSet`. Accepts a partial `ClosureOpts`. PURE. */
export function fromLegacy(opts: ClosureOpts): FeatureSet {
  const names: BundleName[] = [];
  if (opts.withPlayback) names.push('playback');
  if (opts.withAuthz) names.push('authz');
  if (opts.withStaffAdmin) names.push('staff-admin');
  return featureSet(names);
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
