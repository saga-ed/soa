/**
 * The two pure decisions `ss env connect` makes before it touches anything
 * (I#375, Phase 2): WHICH data-plane style an env has, and WHETHER the caller's
 * credential tier may open a tunnel at all.
 *
 * Both are derived from registry DECLARATIONS, never from `env.name` — that is
 * the property under test as much as the answers themselves, so the style cases
 * are driven by synthetic envs as well as the real ones. Nothing here does IO;
 * no test in this file can open a tunnel because no tunnel code is reachable
 * from it.
 */

import { describe, expect, it } from 'vitest';
import {
  DEPLOYED_ENVS,
  READ_ONLY_ROLE,
  callerRoleName,
  connectTierRefusal,
  dataPlaneStyle,
} from '../index.js';
import type { DeployedEnv } from '../index.js';

/** An SSO caller ARN for a given permission set (the shape sts returns). */
const ssoArn = (role: string, account = '531314149529'): string =>
  `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_${role}_1a2b3c4d5e6f7a8b/skelly@saga.org`;

describe('dataPlaneStyle — the reachability branch', () => {
  it('a db-host-v2 fleet (dev, training) means the CloudMap style', () => {
    expect(dataPlaneStyle(DEPLOYED_ENVS['dev']!)).toBe('db-host-cloudmap');
    expect(dataPlaneStyle(DEPLOYED_ENVS['training']!)).toBe('db-host-cloudmap');
  });

  it('no db-host-v2 fleet (prod) means the shared-endpoint style', () => {
    expect(dataPlaneStyle(DEPLOYED_ENVS['prod']!)).toBe('rds-endpoint');
  });

  it('is decided by the DECLARATION, not by the env name', () => {
    // A hypothetical prod-named env WITH a fleet routes via CloudMap, and a
    // dev-named env without one routes to a shared endpoint. If either of these
    // flipped, some `name === 'prod'` test had crept back in.
    expect(dataPlaneStyle({ dbHostNamespace: 'dbs-v2.local' })).toBe('db-host-cloudmap');
    expect(dataPlaneStyle({ dbHostNamespace: undefined })).toBe('rds-endpoint');
    expect(dataPlaneStyle({})).toBe('rds-endpoint');
  });

  it('every registered env resolves to exactly one style, and carries what that style needs', () => {
    for (const env of Object.values(DEPLOYED_ENVS)) {
      if (dataPlaneStyle(env) === 'rds-endpoint') {
        // …otherwise connect can only work with an explicit --host.
        expect(env.postgresEndpointParams, `${env.name} needs endpoint params`).toBeDefined();
      } else {
        expect(env.postgresEndpointParams, `${env.name} has a fleet AND endpoint params`).toBeUndefined();
      }
    }
  });
});

describe('callerRoleName — the tier read off an STS ARN', () => {
  it('unwraps an SSO permission set to the name in ~/.aws/config', () => {
    expect(callerRoleName(ssoArn('Observer'))).toBe('Observer');
    expect(callerRoleName(ssoArn('AdministratorAccess'))).toBe('AdministratorAccess');
    // Permission-set names may contain underscores — only the trailing hex id is stripped.
    expect(callerRoleName(ssoArn('App_Infra'))).toBe('App_Infra');
  });

  it('returns a plain assumed-role name as-is', () => {
    expect(callerRoleName('arn:aws:sts::531314149529:assumed-role/deploy-role/session')).toBe('deploy-role');
  });

  it('is undefined for identities that carry no role, and for junk', () => {
    expect(callerRoleName(undefined)).toBeUndefined();
    expect(callerRoleName('arn:aws:iam::396913734878:user/ci-bot')).toBeUndefined();
    expect(callerRoleName('arn:aws:iam::396913734878:root')).toBeUndefined();
    expect(callerRoleName('')).toBeUndefined();
    expect(callerRoleName('not-an-arn')).toBeUndefined();
  });
});

describe('connectTierRefusal — Observer may read prod, never tunnel into it', () => {
  const prod = DEPLOYED_ENVS['prod']!;

  it('refuses the Observer tier on a production data plane, actionably', () => {
    const msg = connectTierRefusal(ssoArn(READ_ONLY_ROLE), prod)!;
    expect(msg).toContain('credential tier too low');
    expect(msg).toContain('Observer');
    expect(msg).toContain("'prod'");
    expect(msg).toContain('531314149529');
    // Same actionable shape as accountMismatchError — say which knob fixes it.
    expect(msg).toContain('Pass --profile <a prod-capable profile> or set AWS_PROFILE, then retry.');
    // …and say what Observer IS good for, so the read-only user isn't left guessing.
    expect(msg).toContain('ss env list | discover | verify');
    // Never send a prod caller at a dev profile.
    expect(msg).not.toContain('dev_admin');
  });

  it('lets every other tier through on the same env', () => {
    expect(connectTierRefusal(ssoArn('AdministratorAccess'), prod)).toBeNull();
    expect(connectTierRefusal(ssoArn('AppInfra'), prod)).toBeNull();
    expect(connectTierRefusal('arn:aws:iam::531314149529:user/ci-bot', prod)).toBeNull();
  });

  it("does not block when the caller's identity can't be read (the account-preflight stance)", () => {
    expect(connectTierRefusal(undefined, prod)).toBeNull();
  });

  it('never gates a non-production env — dev/training work on any tier', () => {
    expect(connectTierRefusal(ssoArn(READ_ONLY_ROLE, '396913734878'), DEPLOYED_ENVS['dev']!)).toBeNull();
    expect(connectTierRefusal(ssoArn(READ_ONLY_ROLE, '396913734878'), DEPLOYED_ENVS['training']!)).toBeNull();
  });

  it('is a declaration check: a second production env inherits the gate', () => {
    const second: Pick<DeployedEnv, 'name' | 'awsAccountId' | 'productionDataPlane'> = {
      name: 'prod-eu',
      awsAccountId: '999999999999',
      productionDataPlane: true,
    };
    expect(connectTierRefusal(ssoArn(READ_ONLY_ROLE, '999999999999'), second)).toContain("'prod-eu'");
  });
});
