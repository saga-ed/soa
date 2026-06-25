import type { DevPerimeterConfig } from './dev-perimeter-config.js';

/**
 * Shared boot guard for the dev recon perimeter.
 *
 * The perimeter is a **dev-only** JumpCloud recon gate (see
 * dev-perimeter-config.ts for the full topology). Production `*.saga.org`
 * services are END-USER facing and authenticate via iam-api only — JumpCloud
 * gates nothing in prod. This guard enforces that posture at boot: it refuses
 * to start a service in production with the perimeter still ENABLED.
 *
 * Direction (this is the INVERTED guard — the previous version refused
 * perimeter-OFF in prod, under the now-retired "iam-api is the employee
 * perimeter" premise):
 *
 *   - `NODE_ENV=production` + perimeter ON  → violation (refuse to boot).
 *   - any non-prod env (development / test / staging / unset) → no violation;
 *     the perimeter is allowed (and defaults) ON, giving dev & preview their
 *     recon protection.
 *
 * Fail-safe direction: a misdetected NODE_ENV fails toward recon-RETAINED — a
 * visible login outage on an end-user host — never toward silent staff-gating
 * being dropped where it was wanted. (The parse-layer fail-safe in
 * dev-perimeter-config.ts is independent and unchanged: only literal "false"
 * disables the perimeter.)
 *
 * NOT in scope: the future prod **staff** door. Staff/JumpCloud authz in prod
 * is a separate mechanism (separate host/ingress), not this end-user-service
 * toggle — so "perimeter must be off in prod" here does NOT mean "no JumpCloud
 * anywhere in prod."
 *
 * Exposed in two layers so it composes with whatever a service already has:
 *
 *   - {@link devPerimeterProductionViolation} — pure predicate, returns the
 *     message or `null`. A service with an aggregate config asserter folds it
 *     in (`const v = devPerimeterProductionViolation(...); if (v) violations.push(v)`).
 *   - {@link assertDevPerimeterProductionConfig} — convenience that throws iff
 *     the predicate is non-null, for services with no aggregate asserter.
 */
function isProdEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'production';
}

/**
 * Returns the violation message if the dev recon perimeter is enabled in an
 * environment where it must not be (production), or `null` if acceptable.
 */
export function devPerimeterProductionViolation(
  config: Pick<DevPerimeterConfig, 'enabled'>,
  nodeEnv: string | undefined,
): string | null {
  if (config.enabled && isProdEnv(nodeEnv)) {
    return (
      `DEV_PERIMETER_ENABLED must be false in production (NODE_ENV=production). ` +
      'Production *.saga.org services are end-user facing and authenticate via iam-api ' +
      'only; the JumpCloud recon perimeter is a dev-only gate and must not gate prod ' +
      'traffic. (The staff/JumpCloud door is a separate mechanism, not this toggle.)'
    );
  }
  return null;
}

/**
 * Throws if the dev recon perimeter is enabled in production. No-op otherwise.
 * Use in services that boot-check config directly; services with an aggregate
 * asserter should call {@link devPerimeterProductionViolation} and fold the
 * result into their own violation list instead.
 */
export function assertDevPerimeterProductionConfig(
  config: Pick<DevPerimeterConfig, 'enabled'>,
  nodeEnv: string | undefined,
): void {
  const violation = devPerimeterProductionViolation(config, nodeEnv);
  if (violation) throw new Error(violation);
}

// ---------------------------------------------------------------------------
// Deprecated aliases (removed next major). `required` ↔ `enabled`.
// NOTE the SEMANTICS also inverted: the old janusProductionViolation refused
// perimeter-OFF in prod; these aliases now delegate to the new prod-OFF-only
// guard. A caller still on the old name gets the NEW (correct) behavior — which
// is intended, since the old behavior is exactly what we're retiring.
// ---------------------------------------------------------------------------
/** @deprecated Use {@link devPerimeterProductionViolation}. Semantics inverted — see note above. */
export function janusProductionViolation(
  config: { required: boolean },
  nodeEnv: string | undefined,
): string | null {
  return devPerimeterProductionViolation({ enabled: config.required }, nodeEnv);
}

/** @deprecated Use {@link assertDevPerimeterProductionConfig}. Semantics inverted — see note above. */
export function assertJanusProductionConfig(
  config: { required: boolean },
  nodeEnv: string | undefined,
): void {
  assertDevPerimeterProductionConfig({ enabled: config.required }, nodeEnv);
}
