/**
 * Deployed shared-environment registry for the `ss env` family (soa#355).
 *
 * A DeployedEnv names one shared composition and how to reach its control
 * plane: the dev-platform ledger identifier, the AWS account/region, the SSM
 * jump host, and the SSM-parameter roots endpoint discovery walks. `dev`
 * (the `*.wootdev.com` fleet, CI-deployed on merge to main) and `training`
 * (the persistent `*.saga-training.org` tenant) ship built in; both live in
 * the SAME dev AWS account — prod is a different account and deliberately NOT
 * representable here.
 *
 * PURE data + lookups. All AWS IO happens behind the `runtime/aws-cli.ts`
 * seam; endpoint values are DISCOVERED live (`ss env discover`) or overridden
 * per-invocation — nothing here hardcodes a hostname that can drift.
 */

/** The dev AWS account that hosts BOTH shared environments. */
export const DEV_ACCOUNT_ID = '396913734878';

/** The dev-platform control-plane Environment ledger (DynamoDB). */
export const LEDGER_TABLE = 'dev-platform-control-plane-environments-dev';

/** EC2 Name tag of the SSM jump host (the shared ECS instances double as it). */
export const JUMP_HOST_NAME_TAG = 'dev-shared-ecs-instance';

/**
 * Shared ECS clusters, in lookup order — services live on one or the other
 * (live 2026-07-21: arm cluster carries most of the mesh).
 */
export const ECS_CLUSTERS = ['dev-shared-arm', 'dev-shared'];

/**
 * CloudMap private-DNS namespace of the db-host-v2 fleet. Hosts under it are
 * per-service DB containers on db-host EC2 instances; the ASG runs SEVERAL
 * instances, and the shared jump host's SG cannot reach the containers
 * (task-SG allowlists — a dial from the jump host hangs on a dropped SYN,
 * verified live 2026-07-21). Tunnels to these targets therefore route via
 * CloudMap: discover-instances → the container's OWN host instance + port →
 * SSM to THAT instance with a 127.0.0.1 dial (no SG in the path).
 */
export const DB_HOST_CLOUDMAP_NAMESPACE = 'dbs-v2.local';

export interface DeployedEnv {
  /** ss-facing name (`--env dev`). */
  name: string;
  /** dev-platform ledger identifier (`pk = ENV#<identifier>`). */
  ledgerIdentifier: string;
  /** Public apex the composition serves. */
  domain: string;
  awsRegion: string;
  awsAccountId: string;
  /**
   * SSM parameter roots to walk when discovering data-store endpoints, in
   * precedence order (the shared-infra target path first, legacy path second).
   */
  ssmDiscoveryRoots: string[];
  /** One-line description for `ss env list`. */
  description: string;
}

export const DEPLOYED_ENVS: Record<string, DeployedEnv> = {
  dev: {
    name: 'dev',
    ledgerIdentifier: 'main',
    domain: 'wootdev.com',
    awsRegion: 'us-west-2',
    awsAccountId: DEV_ACCOUNT_ID,
    ssmDiscoveryRoots: ['/shared/infra/dev', '/dev'],
    description: 'Shared dev fleet (*.wootdev.com) — CI-deployed on merge to main; data accumulates (no reset).',
  },
  training: {
    name: 'training',
    ledgerIdentifier: 'training',
    domain: 'saga-training.org',
    awsRegion: 'us-west-2',
    awsAccountId: DEV_ACCOUNT_ID,
    ssmDiscoveryRoots: ['/shared/infra/dev', '/dev'],
    description:
      'Persistent training tenant (*.saga-training.org) — manual dispatch deploys; whole-DB reset via rostering reset-training-data.yml only.',
  },
};

/** Resolve a deployed env by name; undefined for unknown names. */
export const resolveEnv = (name: string): DeployedEnv | undefined => DEPLOYED_ENVS[name];

/**
 * The account-preflight message (PURE): null when the caller is in one of the
 * expected accounts (or the account couldn't be read — don't block on that),
 * otherwise an actionable "wrong account — switch profile" string. `label`
 * names what needs the account (an env name, or "the env ledger" for `list`).
 */
export function accountMismatchError(
  callerAccount: string | undefined,
  expectedAccountIds: readonly string[],
  label: string,
): string | null {
  if (callerAccount === undefined || expectedAccountIds.includes(callerAccount)) return null;
  return (
    `AWS account mismatch — your credentials resolve to account ${callerAccount}, but ${label} ` +
    `lives in ${expectedAccountIds.join('/')} (the dev account). Pass --profile <a dev-account profile> ` +
    `(e.g. dev_admin) or set AWS_PROFILE, then retry.`
  );
}

/** The `--env` flag's accepted values, for help text. */
export const ENV_NAMES = Object.keys(DEPLOYED_ENVS);
