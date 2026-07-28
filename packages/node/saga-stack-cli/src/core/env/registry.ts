/**
 * Deployed shared-environment registry for the `ss env` family (soa#355).
 *
 * A DeployedEnv names one shared composition and how to reach its control
 * plane AND its data plane: the dev-platform ledger identifier and table, the
 * AWS account/region, the SSM jump host tag, the shared ECS clusters, and the
 * SSM-parameter roots endpoint discovery walks. `dev` (the `*.wootdev.com`
 * fleet, CI-deployed on merge to main) and `training` (the persistent
 * `*.saga-training.org` tenant) ship built in and live in the SAME dev AWS
 * account; `prod` (`*.saga.org`) is a SECOND account with no ledger, no
 * db-host-v2 fleet, and a reset-forbidden posture.
 *
 * EVERY environment-shaped value is a FIELD, never a module constant (I#375):
 * an env is a parameter, so a second account with a different ledger, jump
 * host, cluster set, or data-plane style is expressible by declaration rather
 * than by branching on `name === '…'`. `ledgerTable` and `dbHostNamespace` are
 * OPTIONAL on purpose — their absence is meaningful ("not ledger-tracked",
 * "no db-host-v2 fleet"), not an omission.
 *
 * PURE data + lookups. All AWS IO happens behind the `runtime/aws-cli.ts`
 * seam; endpoint values are DISCOVERED live (`ss env discover`) or overridden
 * per-invocation — nothing here hardcodes a hostname that can drift.
 */

/** The dev AWS account that hosts BOTH built-in shared environments. */
export const DEV_ACCOUNT_ID = '396913734878';

export interface DeployedEnv {
  /** ss-facing name (`--env dev`). */
  name: string;
  /** dev-platform ledger identifier (`pk = ENV#<identifier>`), also the ECS service suffix. */
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
  /**
   * The dev-platform control-plane Environment ledger (DynamoDB) that tracks
   * this env's resources. ABSENT means the env has no ledger footprint at all
   * — a legitimate state (`ss env list` reports it as such), not an error.
   */
  ledgerTable?: string;
  /** EC2 Name tag of the SSM jump host (the shared ECS instances double as it). */
  jumpHostNameTag: string;
  /**
   * Shared ECS clusters, in lookup order — services live on one or the other
   * (live 2026-07-21: dev's arm cluster carries most of the mesh).
   */
  ecsClusters: readonly string[];
  /**
   * CloudMap private-DNS namespace of the db-host-v2 fleet. Hosts under it are
   * per-service DB containers on db-host EC2 instances; the ASG runs SEVERAL
   * instances, and the shared jump host's SG cannot reach the containers
   * (task-SG allowlists — a dial from the jump host hangs on a dropped SYN,
   * verified live 2026-07-21). Tunnels to these targets therefore route via
   * CloudMap: discover-instances → the container's OWN host instance + port →
   * SSM to THAT instance with a 127.0.0.1 dial (no SG in the path).
   *
   * ABSENT means the env has no db-host-v2 fleet, so there is no CloudMap
   * dance to do and tunnels dial the resolved endpoint straight from the jump
   * host.
   */
  dbHostNamespace?: string;
  /**
   * SSM parameter NAMES (never values) carrying this env's shared Postgres
   * endpoint and port — the RDS data-plane style, the alternative to a
   * db-host-v2 fleet. `ss env connect` reads them at RUN TIME through the aws
   * seam, so the endpoint stays discovered and can be rotated/failed-over
   * without a CLI release; nothing that can drift is stored here.
   *
   * Present on exactly the envs whose `dbHostNamespace` is absent: an env has
   * one data-plane style or the other (see `dataPlaneStyle`). Absent for a
   * db-host-v2 env, where the endpoint comes from the task definition and the
   * CloudMap dance does the routing.
   */
  postgresEndpointParams?: { endpoint: string; port: string };
  /**
   * DECLARES that this environment's data plane holds REAL PRODUCTION data.
   * A posture, not a name test — a second production account inherits it by
   * setting the field. Two consequences today, both in `ss env connect`:
   *
   *   1. the read-only Observer tier is REFUSED (it may read — `list`,
   *      `discover`, `verify` — but not open a tunnel to tenant data), and
   *   2. human-readable output carries a "this is production" banner, with
   *      `--print-only` as the documented default habit.
   */
  productionDataPlane?: true;
  /**
   * DECLARES that `ss env org reset` must refuse this environment outright
   * (I#375). A POSTURE, not a name test: `env org reset` deletes tenant data
   * to restore a synthetic fixture-org skeleton, which has no analogue outside
   * synthetic dev — so an env that holds real tenant data says so HERE and the
   * command inherits the refusal by declaration. There is no --force.
   */
  resetForbidden?: true;
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
    ledgerTable: 'dev-platform-control-plane-environments-dev',
    jumpHostNameTag: 'dev-shared-ecs-instance',
    ecsClusters: ['dev-shared-arm', 'dev-shared'],
    dbHostNamespace: 'dbs-v2.local',
    description: 'Shared dev fleet (*.wootdev.com) — CI-deployed on merge to main; data accumulates (no reset).',
  },
  training: {
    name: 'training',
    ledgerIdentifier: 'training',
    domain: 'saga-training.org',
    awsRegion: 'us-west-2',
    awsAccountId: DEV_ACCOUNT_ID,
    ssmDiscoveryRoots: ['/shared/infra/dev', '/dev'],
    ledgerTable: 'dev-platform-control-plane-environments-dev',
    jumpHostNameTag: 'dev-shared-ecs-instance',
    ecsClusters: ['dev-shared-arm', 'dev-shared'],
    dbHostNamespace: 'dbs-v2.local',
    description:
      'Persistent training tenant (*.saga-training.org) — manual dispatch deploys; whole-DB reset via rostering reset-training-data.yml only.',
  },
  prod: {
    name: 'prod',
    // 'main', NOT 'prod': prod's ECS services carry the SAME `-main` suffix as
    // dev's (`rostering-iam-api-main`, … — live 2026-07-28 on prod-shared), and
    // this field is what composes `<ecsService>-<identifier>`. It is NOT a
    // ledger key here: prod is not ledger-tracked at all (see ledgerTable).
    ledgerIdentifier: 'main',
    // Single apex, established by live HTTPS probing — NOT my.saga.org, which
    // is a user-facing SPA. Prod serves dev's exact <host>.<domain> convention,
    // so `verify` needs no curated prod host table.
    domain: 'saga.org',
    awsRegion: 'us-west-2',
    awsAccountId: '531314149529',
    ssmDiscoveryRoots: ['/shared/infra/prod'],
    jumpHostNameTag: 'prod-shared-ecs-instance',
    // One cluster only — there is no `prod-shared-arm` (the iac samconfig
    // asymmetry against dev is real, not an omission).
    ecsClusters: ['prod-shared'],
    // ledgerTable ABSENT: prod appears in NO dev-platform control-plane ledger
    // (the dev table holds zero prod pks and the prod account has no
    // control-plane table at all) — `ss env list` reports that, never errors.
    // dbHostNamespace ABSENT: prod has no db-host-v2 fleet and no
    // `dbs-v2.local` namespace — its Postgres is RDS, discovered from
    // /shared/infra/prod/postgres-{endpoint,port} (below) at run time.
    postgresEndpointParams: {
      endpoint: '/shared/infra/prod/postgres-endpoint',
      port: '/shared/infra/prod/postgres-port',
    },
    productionDataPlane: true,
    resetForbidden: true,
    description: 'Production (*.saga.org) — not dev-platform ledger-tracked; RDS Postgres; env org reset refuses it.',
  },
};

/** Resolve a deployed env by name; undefined for unknown names. */
export const resolveEnv = (name: string): DeployedEnv | undefined => DEPLOYED_ENVS[name];

/**
 * Per-account credential hints for `accountMismatchError`. Keyed by AWS
 * account id, because the fix a caller needs is account-specific: telling
 * someone who needs production credentials to "pass a dev-account profile
 * (e.g. dev_admin)" is worse than saying nothing at all. Accounts with no
 * entry get the generic wording rather than a wrong one.
 */
const ACCOUNT_HINTS: Record<string, { accountLabel: string; profileNoun: string; exampleProfile: string }> = {
  [DEV_ACCOUNT_ID]: {
    accountLabel: 'the dev account',
    profileNoun: 'a dev-account profile',
    exampleProfile: 'dev_admin',
  },
};

/**
 * The account-preflight message (PURE): null when the caller is in one of the
 * expected accounts (or the account couldn't be read — don't block on that),
 * otherwise an actionable "wrong account — switch profile" string. `label`
 * names what needs the account (an env name, or "the env ledger" for `list`).
 *
 * The account-specific half of the wording is looked up from ACCOUNT_HINTS and
 * only used when EVERY expected account is the same known one; a mixed or
 * unknown expectation degrades to generic phrasing.
 */
export function accountMismatchError(
  callerAccount: string | undefined,
  expectedAccountIds: readonly string[],
  label: string,
): string | null {
  if (callerAccount === undefined || expectedAccountIds.includes(callerAccount)) return null;
  const first = expectedAccountIds[0];
  const hint =
    first !== undefined && expectedAccountIds.every((id) => id === first) ? ACCOUNT_HINTS[first] : undefined;
  const accountLabel = hint === undefined ? '' : ` (${hint.accountLabel})`;
  const profileNoun = hint?.profileNoun ?? 'a matching profile';
  const example = hint === undefined ? '' : ` (e.g. ${hint.exampleProfile})`;
  return (
    `AWS account mismatch — your credentials resolve to account ${callerAccount}, but ${label} ` +
    `lives in ${expectedAccountIds.join('/')}${accountLabel}. Pass --profile <${profileNoun}>${example} ` +
    `or set AWS_PROFILE, then retry.`
  );
}

/** The `--env` flag's accepted values, for help text. */
export const ENV_NAMES = Object.keys(DEPLOYED_ENVS);
