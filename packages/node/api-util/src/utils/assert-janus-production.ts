import type { JanusConfig } from './janus-config.js';

/**
 * Shared boot guard for the Janus employee perimeter.
 *
 * `JANUS_REQUIRED=false` drops the employee Janus perimeter. It exists only so
 * the daily e2e composition can drive deployed backends unattended (no
 * interactive JumpCloud session) — and only on the dev account, where
 * `NODE_ENV=development`. Outside local dev (i.e. real prod, where saga-dash is
 * the EMPLOYEE dashboard on .saga.org) the perimeter is the actual gate;
 * opening it must never be a single CFN-param flip. Defends the perimeter in
 * depth at boot, not by the CFN-template default alone.
 *
 * Exposed in two layers so it composes with whatever a service already has:
 *
 *   - {@link janusProductionViolation} — pure predicate, returns the message
 *     or `null`. A service with an aggregate config asserter folds it in
 *     (`const v = janusProductionViolation(...); if (v) violations.push(v)`)
 *     so its collect-all-violations posture is preserved.
 *   - {@link assertJanusProductionConfig} — convenience that throws iff the
 *     predicate is non-null, for services with no aggregate asserter.
 *
 * `isLocalDev` is `NODE_ENV in {development, test}` — matching the
 * `Fn::If [IsProd, production, development]` task-env wiring, so dev/wootdev
 * tasks (NODE_ENV=development) may run janus-off while real prod refuses it.
 */
function isLocalDevEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Returns the violation message if disabling the Janus perimeter is unsafe for
 * this environment, or `null` if the config is acceptable.
 */
export function janusProductionViolation(
  config: Pick<JanusConfig, 'required'>,
  nodeEnv: string | undefined,
): string | null {
  if (!config.required && !isLocalDevEnv(nodeEnv)) {
    return (
      `JANUS_REQUIRED must be true in any non-development environment (NODE_ENV=${nodeEnv ?? '(unset)'}). ` +
      'Disabling the employee Janus perimeter is a dev-account-only escape hatch for unattended e2e.'
    );
  }
  return null;
}

/**
 * Throws if disabling the Janus perimeter is unsafe for this environment.
 * No-op when the config is acceptable. Use in services that boot-check config
 * directly; services with an aggregate asserter should call
 * {@link janusProductionViolation} and fold the result into their own
 * violation list instead.
 */
export function assertJanusProductionConfig(
  config: Pick<JanusConfig, 'required'>,
  nodeEnv: string | undefined,
): void {
  const violation = janusProductionViolation(config, nodeEnv);
  if (violation) throw new Error(violation);
}
