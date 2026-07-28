/**
 * Deployed-env registry pins (I#375, Phases 0 + 1).
 *
 * The `ss env` family used to read four MODULE-LEVEL constants (LEDGER_TABLE,
 * JUMP_HOST_NAME_TAG, ECS_CLUSTERS, DB_HOST_CLOUDMAP_NAMESPACE); they are now
 * per-env FIELDS so a second AWS account is expressible by declaration. That
 * move is only safe if dev and training came through it byte-for-byte
 * unchanged — every command's AWS targeting is derived from these values, so a
 * single drifted character points a query at the wrong table, cluster, or
 * instance.
 *
 * Every expectation below is a LITERAL on purpose. Re-deriving a value from
 * the module under test would assert only that the module equals itself; the
 * literals ARE the regression net.
 */

import { describe, expect, it } from 'vitest';
import { DEPLOYED_ENVS, DEV_ACCOUNT_ID, ENV_NAMES, PROD_ACCOUNT_ID, accountMismatchError, resolveEnv } from '../index.js';

describe('registry — the built-in envs, pinned field for field', () => {
  it('pins dev', () => {
    expect(DEPLOYED_ENVS['dev']).toEqual({
      name: 'dev',
      ledgerIdentifier: 'main',
      domain: 'wootdev.com',
      awsRegion: 'us-west-2',
      awsAccountId: '396913734878',
      ssmDiscoveryRoots: ['/shared/infra/dev', '/dev'],
      ledgerTable: 'dev-platform-control-plane-environments-dev',
      jumpHostNameTag: 'dev-shared-ecs-instance',
      ecsClusters: ['dev-shared-arm', 'dev-shared'],
      dbHostNamespace: 'dbs-v2.local',
      description:
        'Shared dev fleet (*.wootdev.com) — CI-deployed on merge to main; data accumulates (no reset).',
    });
  });

  it('pins training', () => {
    expect(DEPLOYED_ENVS['training']).toEqual({
      name: 'training',
      ledgerIdentifier: 'training',
      domain: 'saga-training.org',
      awsRegion: 'us-west-2',
      awsAccountId: '396913734878',
      ssmDiscoveryRoots: ['/shared/infra/dev', '/dev'],
      ledgerTable: 'dev-platform-control-plane-environments-dev',
      jumpHostNameTag: 'dev-shared-ecs-instance',
      ecsClusters: ['dev-shared-arm', 'dev-shared'],
      dbHostNamespace: 'dbs-v2.local',
      description:
        'Persistent training tenant (*.saga-training.org) — manual dispatch deploys; whole-DB reset via rostering reset-training-data.yml only.',
    });
  });

  it('pins prod', () => {
    // The two fields most likely to be "corrected" to the wrong thing:
    //  - ledgerIdentifier is 'main', NOT 'prod' — it composes the ECS service
    //    name, and prod's mesh uses the SAME `-main` suffix as dev's.
    //  - domain is the bare apex 'saga.org'; my.saga.org is a user-facing SPA.
    // ledgerTable and dbHostNamespace are ABSENT, which is the whole point:
    // prod is in no dev-platform ledger and has no db-host-v2 fleet.
    expect(DEPLOYED_ENVS['prod']).toEqual({
      name: 'prod',
      ledgerIdentifier: 'main',
      domain: 'saga.org',
      awsRegion: 'us-west-2',
      awsAccountId: '531314149529',
      ssmDiscoveryRoots: ['/shared/infra/prod'],
      jumpHostNameTag: 'prod-shared-ecs-instance',
      ecsClusters: ['prod-shared'],
      // Parameter NAMES, not the endpoint value — the address is read live.
      postgresEndpointParams: {
        endpoint: '/shared/infra/prod/postgres-endpoint',
        port: '/shared/infra/prod/postgres-port',
      },
      productionDataPlane: true,
      resetForbidden: true,
      description:
        'Production (*.saga.org) — not dev-platform ledger-tracked; RDS Postgres; env org reset refuses it.',
    });
    expect(DEPLOYED_ENVS['prod']).not.toHaveProperty('ledgerTable');
    expect(DEPLOYED_ENVS['prod']).not.toHaveProperty('dbHostNamespace');
    expect(DEPLOYED_ENVS['prod']!.awsAccountId).not.toBe(DEV_ACCOUNT_ID);
  });

  it('prod has ONE ECS cluster — there is no prod-shared-arm', () => {
    expect(DEPLOYED_ENVS['prod']!.ecsClusters).toEqual(['prod-shared']);
  });

  it('productionDataPlane is declared on prod ONLY (it gates the connect tier + banner)', () => {
    const production = Object.values(DEPLOYED_ENVS)
      .filter((e) => e.productionDataPlane === true)
      .map((e) => e.name);
    expect(production).toEqual(['prod']);
    expect(DEPLOYED_ENVS['dev']!.productionDataPlane).toBeUndefined();
    expect(DEPLOYED_ENVS['training']!.productionDataPlane).toBeUndefined();
  });

  it('the endpoint PARAMETERS are declared, the endpoint VALUE is not (I#355 stance)', () => {
    // A stored hostname would drift on failover/rotation. Only names here, and
    // only under the env's own discovery root.
    const params = DEPLOYED_ENVS['prod']!.postgresEndpointParams!;
    expect(params.endpoint.startsWith(`${DEPLOYED_ENVS['prod']!.ssmDiscoveryRoots[0]}/`)).toBe(true);
    expect(params.port.startsWith(`${DEPLOYED_ENVS['prod']!.ssmDiscoveryRoots[0]}/`)).toBe(true);
    for (const env of Object.values(DEPLOYED_ENVS)) {
      const json = JSON.stringify(env);
      expect(json).not.toMatch(/rds\.amazonaws\.com/);
    }
    // db-host-v2 envs discover their endpoint from the task definition instead.
    expect(DEPLOYED_ENVS['dev']!.postgresEndpointParams).toBeUndefined();
    expect(DEPLOYED_ENVS['training']!.postgresEndpointParams).toBeUndefined();
  });

  it('resetForbidden is declared on prod ONLY', () => {
    const forbidden = Object.values(DEPLOYED_ENVS)
      .filter((e) => e.resetForbidden === true)
      .map((e) => e.name);
    expect(forbidden).toEqual(['prod']);
    expect(DEPLOYED_ENVS['dev']!.resetForbidden).toBeUndefined();
    expect(DEPLOYED_ENVS['training']!.resetForbidden).toBeUndefined();
  });

  it('ECS cluster lookup ORDER is part of the contract (arm first)', () => {
    // The first cluster that answers wins, so order decides which service a
    // duplicate name resolves to — not an incidental array literal.
    expect(DEPLOYED_ENVS['dev']!.ecsClusters[0]).toBe('dev-shared-arm');
    expect(DEPLOYED_ENVS['training']!.ecsClusters[0]).toBe('dev-shared-arm');
  });

  it('SSM discovery root PRECEDENCE is part of the contract (shared-infra first)', () => {
    expect(DEPLOYED_ENVS['dev']!.ssmDiscoveryRoots[0]).toBe('/shared/infra/dev');
    expect(DEPLOYED_ENVS['training']!.ssmDiscoveryRoots[0]).toBe('/shared/infra/dev');
  });

  it('both dev-platform envs live in the one dev account; prod does not', () => {
    expect(DEV_ACCOUNT_ID).toBe('396913734878');
    expect(DEPLOYED_ENVS['dev']!.awsAccountId).toBe(DEV_ACCOUNT_ID);
    expect(DEPLOYED_ENVS['training']!.awsAccountId).toBe(DEV_ACCOUNT_ID);
    expect(DEPLOYED_ENVS['prod']!.awsAccountId).toBe('531314149529');
  });

  it('exposes exactly these env names, in this order (the --env help text)', () => {
    expect(ENV_NAMES).toEqual(['dev', 'training', 'prod']);
  });

  it('resolveEnv is name-keyed and undefined for anything else', () => {
    expect(resolveEnv('dev')!.domain).toBe('wootdev.com');
    expect(resolveEnv('training')!.domain).toBe('saga-training.org');
    expect(resolveEnv('prod')!.domain).toBe('saga.org');
    expect(resolveEnv('production')).toBeUndefined();
    expect(resolveEnv('')).toBeUndefined();
    expect(resolveEnv('DEV')).toBeUndefined();
  });
});

describe('accountMismatchError — actionable, and never wrong about WHICH account', () => {
  it('is silent when the caller is in an expected account', () => {
    expect(accountMismatchError('396913734878', ['396913734878'], "'dev'")).toBeNull();
    expect(accountMismatchError('396913734878', ['531314149529', '396913734878'], "'dev'")).toBeNull();
  });

  it("is silent when the caller's account could not be read (don't block on that)", () => {
    expect(accountMismatchError(undefined, ['396913734878'], "'dev'")).toBeNull();
  });

  it('names the dev account and a dev profile when dev is what is expected', () => {
    expect(accountMismatchError('531314149529', ['396913734878'], 'the env ledger')).toBe(
      'AWS account mismatch — your credentials resolve to account 531314149529, but the env ledger ' +
        'lives in 396913734878 (the dev account). Pass --profile <a dev-account profile> (e.g. dev_admin) ' +
        'or set AWS_PROFILE, then retry.',
    );
  });

  it('names the PROD account and a prod profile when prod is what is expected', () => {
    // The dev wording is a lie for any other account: telling someone who needs
    // production credentials to pass `dev_admin` sends them the wrong way. But
    // degrading to a bare "<a matching profile>" is barely better — I#375
    // requires prod's message to be as actionable as dev's, so it names one.
    const msg = accountMismatchError('396913734878', ['531314149529'], "'prod'")!;
    expect(msg).toBe(
      'AWS account mismatch — your credentials resolve to account 396913734878, but ' + "'prod' " +
        'lives in 531314149529 (the production account). Pass --profile <a prod-account profile> ' +
        '(e.g. prod_admin) or set AWS_PROFILE, then retry.',
    );
    expect(msg).not.toContain('dev_admin');
    expect(msg).not.toContain('the dev account');
    expect(msg).not.toContain('dev-account profile');
  });

  it('still degrades to generic wording for an account it has no hint for', () => {
    const msg = accountMismatchError('396913734878', ['999999999999'], "'someday'")!;
    expect(msg).toContain('lives in 999999999999. Pass --profile <a matching profile>');
    expect(msg).not.toContain('e.g.');
  });

  it('degrades to generic wording when the expectation spans several accounts', () => {
    const msg = accountMismatchError('111111111111', ['396913734878', '531314149529'], 'the env ledger')!;
    expect(msg).toContain('lives in 396913734878/531314149529. Pass --profile <a matching profile>');
    expect(msg).not.toContain('dev_admin');
  });
});
