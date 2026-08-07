/**
 * Credential-tier gate for `ss env connect` (I#375, Phase 2, Q5) — PURE.
 *
 * DECIDED POLICY: the read-only commands (`list`, `discover`, `verify`) accept
 * the Observer tier — they read SSM parameter names, EC2 tags, ledger rows and
 * HTTP health bodies. `connect` does not: it opens a LIVE tunnel to an
 * environment's tenant data, so on an env that declares `productionDataPlane`
 * it refuses Observer and says which knob fixes it, in the same shape
 * `accountMismatchError` uses ("pass --profile … or set AWS_PROFILE, then
 * retry").
 *
 * The tier is read off the STS caller ARN, which for SSO identities embeds the
 * permission-set name: `arn:aws:sts::<acct>:assumed-role/AWSReservedSSO_<set>_<id>/<user>`.
 * The check is deliberately POSITIVE-ONLY — it refuses when the caller is
 * PROVEN to be Observer, and lets an identity it cannot classify through
 * (matching `resolveCallerAccount`'s "don't block on an unreadable identity"
 * stance). A tier that is genuinely too low but unrecognizable still fails at
 * the AWS call, with AWS's own AccessDenied; a false refusal, by contrast,
 * would lock out legitimate roles this CLI has never heard of.
 */

import type { DeployedEnv } from './registry.js';

/** The SSO permission set that may read a shared env but never tunnel into it. */
export const READ_ONLY_ROLE = 'Observer';

/**
 * The role / SSO permission-set name an STS caller ARN resolves to, or
 * undefined when the ARN carries none (an IAM user, the account root, an
 * unparseable string). `AWSReservedSSO_<set>_<id>` unwraps to `<set>` — the
 * name the user sees in `~/.aws/config` as `sso_role_name`.
 */
export function callerRoleName(arn: string | undefined): string | undefined {
  if (arn === undefined) return undefined;
  // arn:partition:service:region:account:resource — the resource may itself
  // contain ':' , so rejoin everything from field 5 on.
  const resource = arn.split(':').slice(5).join(':');
  const [kind, name] = resource.split('/');
  if (kind !== 'assumed-role' || name === undefined || name === '') return undefined;
  // LAZY on purpose: a permission-set name may itself contain '_' (App_Infra),
  // and only the TRAILING hex account-role id is the part to strip.
  const sso = /^AWSReservedSSO_(.+?)_[0-9a-f]{8,}$/.exec(name);
  return sso?.[1] ?? name;
}

/**
 * The `env connect` credential-gate message (PURE): null when the tunnel may
 * proceed, otherwise an actionable "switch profile" string. Only environments
 * that DECLARE `productionDataPlane` are gated — dev and training are
 * unaffected, on any tier.
 */
export function connectTierRefusal(
  callerArn: string | undefined,
  env: Pick<DeployedEnv, 'name' | 'awsAccountId' | 'productionDataPlane'>,
): string | null {
  if (env.productionDataPlane !== true) return null;
  if (callerRoleName(callerArn) !== READ_ONLY_ROLE) return null;
  return (
    `credential tier too low — your credentials resolve to the read-only ${READ_ONLY_ROLE} role ` +
    `(${callerArn}), and env connect opens a LIVE tunnel to '${env.name}' tenant data in account ` +
    `${env.awsAccountId}. Pass --profile <a ${env.name}-capable profile> or set AWS_PROFILE, then retry. ` +
    `(${READ_ONLY_ROLE} is enough for the read-only ss env list | discover | verify.)`
  );
}
