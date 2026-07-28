/**
 * `ss env` integration tests (soa#355, Phase 0) — in-process command runs with
 * the two IO seams (`getEnvAws`, `getEnvPsql`) faked on `BaseCommand.prototype`,
 * so NO aws call, tunnel, or database is ever touched.
 *
 * Covers: `env list` ledger summarization + the AccessDenied tier hint;
 * `env discover` pagination, name filtering, and jump-host resolution;
 * `env connect` candidate-order endpoint/secret resolution, `--print-only`
 * (no tunnel), and the tunnel request shape; `env org status` slug-only
 * targeting (unknown org / raw UUID refused), offline-partial vs live id-set
 * resolution, and per-table counts with projections marked.
 */

import { Config } from '@oclif/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCommand } from '../../../base-command.js';
import type { EnvAws, EnvPsql, PortForwardHandle, PortForwardRequest } from '../../../runtime/index.js';
import EnvConnect from '../connect.js';
import EnvDiscover from '../discover.js';
import EnvList from '../list.js';
import EnvOrgStatus from '../org/status.js';

const PKG_ROOT = process.cwd();
const ORG_ID = '52a00136-285b-522c-bc70-0887cf46463a';

let config: Config;
let out: string[];
/** Recorded aws json calls: [joined args, opts]. */
let awsCalls: { args: string[]; opts?: { profile?: string; region?: string } }[];
let portForwards: PortForwardRequest[];
/** Recorded psql calls: [connString, sql]. */
let psqlCalls: { conn: string; sql: string }[];

type AwsHandler = (args: string[]) => unknown;
type PsqlHandler = (conn: string, sql: string) => string[][];

/** Account the sts preflight resolves to (default: the dev account; a test flips it to simulate a mismatch). */
const DEV_ACCOUNT = '396913734878';
const PROD_ACCOUNT = '531314149529';
let callerAccount = DEV_ACCOUNT;
/**
 * ARN the CREDENTIAL-TIER gate resolves to (`env connect` on a production data
 * plane only — nothing else asks). Default: an admin permission set, i.e. the
 * gate passes; the Observer test swaps in the read-only one.
 */
const ssoArn = (role: string, account: string): string =>
  `arn:aws:sts::${account}:assumed-role/AWSReservedSSO_${role}_1a2b3c4d5e6f7a8b/skelly@saga.org`;
let callerArn = ssoArn('AdministratorAccess', PROD_ACCOUNT);

function installEnvAws(handler: AwsHandler): void {
  const fake: EnvAws = {
    async json(args, opts): Promise<unknown> {
      awsCalls.push({ args, opts });
      // The account preflight (env list/discover/connect) and the connect
      // credential gate (--query Arn, production envs only) — answered here so
      // no per-test handler needs to know about them; a test sets
      // callerAccount/callerArn to flip either.
      if (args[0] === 'sts' && args[1] === 'get-caller-identity') {
        return args.includes('Arn') ? callerArn : callerAccount;
      }
      return handler(args);
    },
    async lambdaInvoke(): Promise<unknown> {
      throw new Error('unexpected lambdaInvoke in Phase-0 env tests');
    },
    portForward(req): PortForwardHandle {
      portForwards.push(req);
      return { pid: 4242, ready: Promise.resolve(), exited: Promise.resolve(0), stop: () => undefined };
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getEnvAws: () => EnvAws },
    'getEnvAws',
  ).mockReturnValue(fake);
}

function installEnvPsql(handler: PsqlHandler = () => [['0']]): void {
  const fake: EnvPsql = {
    async query(conn, sql): Promise<string[][]> {
      psqlCalls.push({ conn, sql });
      return handler(conn, sql);
    },
  };
  vi.spyOn(
    BaseCommand.prototype as unknown as { getEnvPsql: () => EnvPsql },
    'getEnvPsql',
  ).mockReturnValue(fake);
}

beforeEach(async () => {
  config = await Config.load(PKG_ROOT);
  out = [];
  awsCalls = [];
  portForwards = [];
  psqlCalls = [];
  callerAccount = DEV_ACCOUNT;
  callerArn = ssoArn('AdministratorAccess', PROD_ACCOUNT);
  vi.spyOn(
    BaseCommand.prototype as unknown as { log: (msg?: string) => void },
    'log',
  ).mockImplementation((msg?: string) => {
    out.push(String(msg ?? ''));
  });
  installEnvAws(() => null);
  installEnvPsql();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (): string => out.join('\n');

/**
 * Every `Name=tag:Name,Values=…` filter that actually reached `ec2
 * describe-instances`. The jump-host tag is PER-ENV (dev and prod tag their
 * shared ECS instances differently), and a fake that answers any `ec2` call
 * would let a hardcoded dev tag pass in prod — where it matches nothing and
 * every tunnel dies with "no running+Online SSM jump host".
 */
const ec2NameTagFilters = (): string[] =>
  awsCalls
    .filter((c) => c.args[0] === 'ec2')
    .flatMap((c) => c.args.filter((a) => a.startsWith('Name=tag:Name,Values=')));

describe('env list — ledger summary', () => {
  it('summarizes resource kinds per environment from the ledger query', async () => {
    installEnvAws((args) => {
      if (args[0] === 'dynamodb') {
        return { Items: [{ sk: { S: 'RES#ecs#svc-a' } }, { sk: { S: 'RES#ecs#svc-b' } }, { sk: { S: 'RES#db#x' } }] };
      }
      return null;
    });

    await expect(EnvList.run([], config)).resolves.toBeUndefined();

    expect(text()).toContain('Deployed shared environments');
    // Colour is TTY-gated (off under vitest), so assert the aligned plain text.
    expect(text()).toMatch(/dev\s+\*\.wootdev\.com\s+\(main\)/);
    expect(text()).toMatch(/training\s+\*\.saga-training\.org\s+\(training\)/);
    expect(text()).toContain('db×1  ecs×2');
    // One ledger query per registered env.
    expect(awsCalls.filter((c) => c.args[0] === 'dynamodb')).toHaveLength(2);
  });

  it('lists a ledger-less env explicitly, with NO query and NO credential demand of its own', async () => {
    // prod is in no dev-platform ledger (I#375). That must read as a stated
    // fact, not as an error and not as a blank that looks like "zero
    // resources" — and listing it must not require prod credentials, so its
    // account never joins the preflight expectation.
    installEnvAws((args) => {
      if (args[0] === 'dynamodb') {
        const values = args[args.indexOf('--expression-attribute-values') + 1] ?? '';
        // Only the two dev-ledger envs may ever be queried.
        expect(values).toMatch(/ENV#(main|training)/);
        return { Items: [{ sk: { S: 'RES#ecs#svc-a' } }] };
      }
      return null;
    });

    await expect(EnvList.run([], config)).resolves.toBeUndefined();

    expect(text()).toMatch(/prod\s+\*\.saga\.org\s+\(main\)/);
    expect(text()).toContain('not ledger-tracked (prod is not a dev-platform environment)');
    // Two ledger queries, not three — prod's account is never touched.
    expect(awsCalls.filter((c) => c.args[0] === 'dynamodb')).toHaveLength(2);
    expect(awsCalls.some((c) => c.opts?.region === 'us-west-2' && c.args[0] === 'dynamodb')).toBe(true);
  });

  it('a dev-account caller is NOT rejected just because a prod env is in the registry', async () => {
    // The preflight expectation narrows to the accounts of LEDGER-TRACKED envs;
    // if prod's account leaked into it, every dev-credentialed `ss env list`
    // would fail on an account "mismatch" against an env it never queries.
    installEnvAws((args) => (args[0] === 'dynamodb' ? { Items: [] } : null));
    callerAccount = DEV_ACCOUNT;
    await expect(EnvList.run([], config)).resolves.toBeUndefined();
    expect(text()).toContain('(no resource rows)');
    expect(text()).toContain('not ledger-tracked');
  });

  it('wrong AWS account is refused up front with the switch-profile hint (not a cryptic ledger error)', async () => {
    callerAccount = '531314149529'; // the prod account — the dev ledger does not exist there
    installEnvAws(() => {
      throw new Error('the ledger must never be queried on an account mismatch');
    });

    await expect(EnvList.run([], config)).rejects.toThrow(/account mismatch.*531314149529.*dev_admin/s);
    // No dynamodb query was attempted (only the sts preflight ran).
    expect(awsCalls.every((c) => c.args[0] === 'sts')).toBe(true);
  });

  it('maps AccessDenied to the tier hint (wrong tier, not missing env)', async () => {
    installEnvAws(() => {
      throw new Error('An error occurred (AccessDeniedException): … AccessDenied');
    });

    await expect(EnvList.run([], config)).resolves.toBeUndefined();
    expect(text()).toContain('observer tier cannot read the ledger');
  });
});

describe('env discover — SSM walk + jump host', () => {
  it('pages get-parameters-by-path, filters names, and resolves the Online jump host', async () => {
    installEnvAws((args) => {
      if (args[1] === 'get-parameters-by-path') {
        const paged = args.includes('--next-token');
        if (args.includes('/shared/infra/dev') && !paged) {
          return {
            Parameters: [
              { Name: '/shared/infra/dev/postgres-endpoint', Type: 'String' },
              { Name: '/shared/infra/dev/app-alb-443-listener-arn', Type: 'String' }, // filtered out
            ],
            NextToken: 'page2',
          };
        }
        if (paged) return { Parameters: [{ Name: '/shared/infra/dev/mongodb-hosts', Type: 'StringList' }] };
        return { Parameters: [] };
      }
      // Tag-sensitive on purpose: the instance only comes back for the tag the
      // registry declares for THIS env.
      if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=dev-shared-ecs-instance') ? ['i-0abc'] : [];
      if (args[1] === 'describe-instance-information') return ['i-0abc'];
      return null;
    });

    await expect(EnvDiscover.run(['--env', 'dev'], config)).resolves.toBeUndefined();

    expect(text()).toContain('/shared/infra/dev/postgres-endpoint');
    expect(text()).toContain('/shared/infra/dev/mongodb-hosts');
    expect(text()).not.toContain('app-alb-443-listener-arn');
    expect(text()).toContain('jump host: i-0abc');
    expect(ec2NameTagFilters()).toEqual(['Name=tag:Name,Values=dev-shared-ecs-instance']);
    expect(text()).toContain('tag Name=dev-shared-ecs-instance');
  });

  it('--env prod walks the PROD root and filters EC2 by the PROD jump-host tag', async () => {
    // Both values are per-env registry fields (I#375). The tag is the one that
    // is silently substitutable: a dev tag in the prod account matches nothing,
    // so `discover` and every `connect` tunnel would die on "no jump host".
    callerAccount = PROD_ACCOUNT;
    installEnvAws((args) => {
      if (args[1] === 'get-parameters-by-path') {
        expect(args[args.indexOf('--path') + 1]).toBe('/shared/infra/prod');
        return { Parameters: [{ Name: '/shared/infra/prod/postgres-endpoint', Type: 'String' }] };
      }
      if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=prod-shared-ecs-instance') ? ['i-0prodjump'] : [];
      if (args[1] === 'describe-instance-information') return ['i-0prodjump'];
      return null;
    });

    await expect(EnvDiscover.run(['--env', 'prod'], config)).resolves.toBeUndefined();

    expect(text()).toContain('/shared/infra/prod/postgres-endpoint');
    expect(ec2NameTagFilters()).toEqual(['Name=tag:Name,Values=prod-shared-ecs-instance']);
    expect(text()).toContain('jump host: i-0prodjump');
    expect(text()).toContain('tag Name=prod-shared-ecs-instance');
    // Prod declares ONE discovery root — dev's legacy roots must not leak in.
    const paths = awsCalls.filter((c) => c.args[1] === 'get-parameters-by-path').map((c) => c.args[c.args.indexOf('--path') + 1]);
    expect(paths).toEqual(['/shared/infra/prod']);
  });
});

describe('env connect — task-definition resolution + tunnel', () => {
  /** Live-verified shapes: iam = DATABASE_URL secret on the arm cluster; ads-adm = split POSTGRES_* env. */
  const awsForConnect = (args: string[]): unknown => {
    if (args[1] === 'describe-services') {
      const cluster = args[args.indexOf('--cluster') + 1];
      const service = args[args.indexOf('--services') + 1];
      if (service === 'rostering-iam-api-main' && cluster === 'dev-shared-arm') return 'arn:td/iam:251';
      if (service === 'sds-ads-adm-api-main' && cluster === 'dev-shared') return 'arn:td/adsadm:26';
      return null; // oclif --query yields null for a missing service
    }
    if (args[1] === 'describe-task-definition') {
      const td = args[args.indexOf('--task-definition') + 1];
      if (td === 'arn:td/iam:251') {
        return [
          {
            name: 'iam-api',
            secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:us-west-2:396913734878:secret:rostering/dev/database-url' }],
          },
        ];
      }
      return [
        {
          name: 'ads-adm-api',
          environment: [
            { name: 'POSTGRES_HOST', value: 'ads-adm-postgres.dbs-v2.local' },
            { name: 'POSTGRES_PORT', value: '5471' },
            { name: 'POSTGRES_DATABASE', value: 'ads_adm' },
            { name: 'POSTGRES_USERNAME', value: 'ads_adm_app' },
          ],
          secrets: [{ name: 'POSTGRES_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-west-2:396913734878:secret:sds/ads-adm-api/postgres-creds' }],
        },
      ];
    }
    if (args[0] === 'secretsmanager') {
      const id = args[args.indexOf('--secret-id') + 1];
      if (id.includes('rostering/dev/database-url')) return 'postgresql://postgres_admin:p%40ss@rostering-iam-canonical.dbs-v2.local:5440/rostering-iam-canonical';
      return 'split-pw';
    }
    if (args[0] === 'servicediscovery') {
      return { Instances: [{ Attributes: { AWS_INSTANCE_IPV4: '10.3.0.9', AWS_INSTANCE_PORT: '5440' } }] };
    }
    if (args[0] === 'ec2' && args.some((a) => a.includes('private-ip-address'))) return ['i-0dbhost'];
    if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=dev-shared-ecs-instance') ? ['i-0jump'] : [];
    if (args[1] === 'describe-instance-information') return ['i-0jump'];
    return null;
  };

  it('--print-only resolves a DATABASE_URL-secret service and opens NO tunnel', async () => {
    installEnvAws(awsForConnect);

    await expect(EnvConnect.run(['iam', '--print-only'], config)).resolves.toBeUndefined();

    expect(text()).toContain('service candidate dev-shared-arm/rostering-iam-api-main: arn:td/iam:251');
    expect(text()).toContain('rostering-iam-canonical.dbs-v2.local:5440/rostering-iam-canonical');
    // .dbs-v2.local ⇒ the CloudMap route via the container's own host instance.
    expect(text()).toContain('db-host i-0dbhost (CloudMap rostering-iam-canonical, local dial :5440)');
    expect(text()).toContain('DATABASE_URL=postgres://postgres_admin:p%40ss@127.0.0.1:15432/rostering-iam-canonical');
    expect(portForwards).toHaveLength(0);
  });

  it('resolves a split POSTGRES_* service (second cluster) and tunnels via the db-host with a local dial', async () => {
    installEnvAws(awsForConnect);

    await expect(EnvConnect.run(['ads-adm', '--local-port', '15433'], config)).resolves.toBeUndefined();

    expect(text()).toContain('service candidate dev-shared-arm/sds-ads-adm-api-main: not found');
    expect(portForwards).toEqual([
      {
        target: 'i-0dbhost',
        host: '127.0.0.1',
        remotePort: 5440, // the CloudMap-registered port wins over the env var
        localPort: 15433,
        region: 'us-west-2',
        profile: undefined,
      },
    ]);
    expect(text()).toContain('DATABASE_URL=postgres://ads_adm_app:split-pw@127.0.0.1:15433/ads_adm');
  });

  it('a service deployed on neither cluster is a hard error naming both', async () => {
    installEnvAws((args) => (args[1] === 'describe-services' ? null : ['i-0jump']));

    await expect(EnvConnect.run(['coach'], config)).rejects.toThrow(/not found in dev-shared-arm or dev-shared/);
    expect(portForwards).toHaveLength(0);
  });

  it('--host skips task-def resolution but still routes .dbs-v2.local via CloudMap', async () => {
    installEnvAws((args) => {
      if (args[0] === 'servicediscovery') return { Instances: [{ Attributes: { AWS_INSTANCE_IPV4: '10.3.0.9' } }] };
      if (args[0] === 'ec2' && args.some((a) => a.includes('private-ip-address'))) return ['i-0dbhost'];
      throw new Error(`unexpected aws call: ${args.join(' ')}`);
    });

    await expect(
      EnvConnect.run(['iam', '--host', 'x.dbs-v2.local', '--remote-port', '5440', '--database', 'iamdb', '--print-only'], config),
    ).resolves.toBeUndefined();
    expect(text()).toContain('x.dbs-v2.local:5440/iamdb (--host)');
    expect(text()).toContain('db-host i-0dbhost (CloudMap x, local dial :5440)');
  });

  it('a non-CloudMap host (shared RDS) routes via the shared jump host', async () => {
    installEnvAws((args) => {
      if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=dev-shared-ecs-instance') ? ['i-0jump'] : [];
      if (args[1] === 'describe-instance-information') return ['i-0jump'];
      throw new Error(`unexpected aws call: ${args.join(' ')}`);
    });

    await expect(
      EnvConnect.run(['coach', '--host', 'shared.rds.amazonaws.com', '--database', 'coach', '--print-only'], config),
    ).resolves.toBeUndefined();
    expect(text()).toContain('route:     jump host i-0jump');
    expect(ec2NameTagFilters()).toEqual(['Name=tag:Name,Values=dev-shared-ecs-instance']);
  });
});

describe('env connect --env prod — the RDS data-plane style (I#375)', () => {
  const RDS = 'prod-shared-pg.cluster-abc123.us-west-2.rds.amazonaws.com';

  /**
   * Prod's shape, live-verified 2026-07-28: ONE cluster (`prod-shared`), the
   * same `-main` service suffix as dev, NO db-host-v2 fleet, and a Postgres
   * endpoint that exists only in SSM. The task def deliberately names a
   * DIFFERENT (private-alias) host so the substitution is observable.
   */
  const awsForProd = (args: string[]): unknown => {
    if (args[1] === 'describe-services') {
      const cluster = args[args.indexOf('--cluster') + 1];
      const service = args[args.indexOf('--services') + 1];
      return cluster === 'prod-shared' && service === 'rostering-iam-api-main' ? 'arn:td/prod-iam:9' : null;
    }
    if (args[1] === 'describe-task-definition') {
      return [
        {
          name: 'iam-api',
          secrets: [{ name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:us-west-2:531314149529:secret:rostering/prod/database-url' }],
        },
      ];
    }
    if (args[0] === 'secretsmanager') return 'postgresql://iam_app:pw@iam.dbs.internal:5432/iam';
    if (args[1] === 'get-parameter') {
      const name = args[args.indexOf('--name') + 1];
      if (name === '/shared/infra/prod/postgres-endpoint') return RDS;
      if (name === '/shared/infra/prod/postgres-port') return '5432';
      return null;
    }
    // Only the PROD tag matches — dev's tag finds nothing in this account.
    if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=prod-shared-ecs-instance') ? ['i-0prodjump'] : [];
    if (args[1] === 'describe-instance-information') return ['i-0prodjump'];
    if (args[0] === 'servicediscovery') throw new Error('prod has no CloudMap db-host fleet — must never be asked');
    return null;
  };

  beforeEach(() => {
    callerAccount = PROD_ACCOUNT;
  });

  it('--print-only resolves the endpoint LIVE from SSM, banners production, and opens nothing', async () => {
    installEnvAws(awsForProd);

    await expect(EnvConnect.run(['iam', '--env', 'prod', '--print-only'], config)).resolves.toBeUndefined();

    expect(text()).toContain('this is PRODUCTION');
    expect(text()).toContain('Resolving only (--print-only)');
    // The task def still supplies database + user…
    expect(text()).toContain('service candidate prod-shared/rostering-iam-api-main: arn:td/prod-iam:9');
    // …but the ADDRESS comes from SSM, and the substitution is stated, not silent.
    expect(text()).toContain(`endpoint:  ${RDS}:5432`);
    expect(text()).toContain('SSM /shared/infra/prod/postgres-endpoint; task def named iam.dbs.internal:5432');
    expect(text()).toContain(`target:    ${RDS}:5432/iam`);
    // Straight from the PROD jump host — no CloudMap, no 127.0.0.1 dial. The
    // tag is the registry's, not dev's constant (which matches nothing here).
    expect(text()).toContain('route:     jump host i-0prodjump');
    expect(ec2NameTagFilters()).toEqual(['Name=tag:Name,Values=prod-shared-ecs-instance']);
    expect(text()).not.toContain('db-host');
    expect(text()).toContain('DATABASE_URL=postgres://iam_app:pw@127.0.0.1:15432/iam');
    expect(portForwards).toHaveLength(0);
    // The endpoint is NEVER a registry literal — it was read at run time.
    const reads = awsCalls.filter((c) => c.args[1] === 'get-parameter').map((c) => c.args[c.args.indexOf('--name') + 1]);
    expect(reads).toEqual(['/shared/infra/prod/postgres-endpoint', '/shared/infra/prod/postgres-port']);
  });

  it('tunnels from the jump host STRAIGHT to the discovered endpoint', async () => {
    installEnvAws(awsForProd);

    await expect(EnvConnect.run(['iam', '--env', 'prod', '--local-port', '15442'], config)).resolves.toBeUndefined();

    expect(portForwards).toEqual([
      {
        target: 'i-0prodjump',
        host: RDS, // the endpoint itself, NOT 127.0.0.1
        remotePort: 5432,
        localPort: 15442,
        region: 'us-west-2',
        profile: undefined,
      },
    ]);
    expect(awsCalls.some((c) => c.args[0] === 'servicediscovery')).toBe(false);
  });

  it('REFUSES the read-only Observer tier before resolving or connecting anything', async () => {
    callerArn = ssoArn('Observer', PROD_ACCOUNT);
    installEnvAws(awsForProd);

    await expect(EnvConnect.run(['iam', '--env', 'prod', '--print-only'], config)).rejects.toThrow(
      /credential tier too low.*Observer.*Pass --profile <a prod-capable profile>/s,
    );
    // Nothing beyond the two identity reads happened — no ECS lookup, no secret
    // fetch, no endpoint read, and certainly no tunnel.
    expect(awsCalls.every((c) => c.args[0] === 'sts')).toBe(true);
    expect(portForwards).toHaveLength(0);
  });

  it('--host stays the escape hatch: no task def, no SSM endpoint read', async () => {
    installEnvAws((args) => {
      if (args[1] === 'get-parameter') throw new Error('--host must skip endpoint discovery');
      if (args[1] === 'describe-services') throw new Error('--host must skip task-def resolution');
      if (args[0] === 'ec2') return args.includes('Name=tag:Name,Values=prod-shared-ecs-instance') ? ['i-0prodjump'] : [];
      if (args[1] === 'describe-instance-information') return ['i-0prodjump'];
      return null;
    });

    await expect(
      EnvConnect.run(
        ['iam', '--env', 'prod', '--host', 'other.rds.amazonaws.com', '--remote-port', '6543', '--database', 'iam', '--print-only'],
        config,
      ),
    ).resolves.toBeUndefined();

    expect(text()).toContain('other.rds.amazonaws.com:6543/iam (--host)');
    expect(text()).toContain('route:     jump host i-0prodjump');
  });
});

describe('env connect --env dev — the db-host style is untouched by the prod work', () => {
  it('asks for NO endpoint parameter and runs NO credential-tier check', async () => {
    // dev declares a db-host fleet and no production posture, so neither the
    // SSM endpoint read nor the `--query Arn` identity read may appear. Both
    // showing up would mean the style branch leaked into the dev path.
    installEnvAws((args) => {
      if (args[0] === 'servicediscovery') return { Instances: [{ Attributes: { AWS_INSTANCE_IPV4: '10.3.0.9' } }] };
      if (args[0] === 'ec2') return ['i-0dbhost'];
      return null;
    });

    await expect(
      EnvConnect.run(['iam', '--host', 'x.dbs-v2.local', '--remote-port', '5440', '--database', 'iamdb', '--print-only'], config),
    ).resolves.toBeUndefined();

    expect(awsCalls.some((c) => c.args[1] === 'get-parameter')).toBe(false);
    expect(awsCalls.some((c) => c.args.includes('Arn'))).toBe(false);
    expect(text()).not.toContain('this is PRODUCTION');
    expect(text()).toContain('db-host i-0dbhost (CloudMap x, local dial :5440)');
  });
});

describe('env org status — slug-only targeting + footprint', () => {
  it('refuses unknown slugs AND raw UUIDs with the catalog listing', async () => {
    await expect(EnvOrgStatus.run(['--org', 'jennys-training-org'], config)).rejects.toThrow(/not a resettable fixture org/);
    await expect(EnvOrgStatus.run(['--org', ORG_ID], config)).rejects.toThrow(/not a resettable fixture org/);
    expect(psqlCalls).toHaveLength(0);
  });

  it('offline mode: catalog ids only, every store skipped without a connection', async () => {
    await expect(EnvOrgStatus.run(['--org', 'emptyOrg', '--offline'], config)).resolves.toBeUndefined();

    expect(text()).toContain(ORG_ID);
    expect(text()).toContain('resolution: partial-offline');
    expect(text()).toContain('groups=1 users=1 programs=0');
    expect(text()).toContain('no connection (--url)');
    expect(psqlCalls).toHaveLength(0);
  });

  it('live mode: resolves id-sets from the anchors and counts per table (projections marked)', async () => {
    const SCHOOL = 'b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6';
    const USER = '92c6c9f4-c764-519f-9873-7df7b77f5410';
    const PROGRAM = 'ea1562ee-a620-5d5c-82a8-768da7f798c2';
    installEnvPsql((conn, sql) => {
      if (sql.startsWith('SELECT id FROM groups')) return [[SCHOOL]];
      if (sql.includes('DISTINCT user_id')) return [[USER]];
      if (sql.startsWith('SELECT id FROM "Program"')) return [[PROGRAM]];
      if (sql.startsWith('SELECT count(*)')) return [['7']];
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(
      EnvOrgStatus.run(
        ['--org', 'emptyOrg', '--url', 'iam=postgres://iam', '--url', 'programs=postgres://pgm'],
        config,
      ),
    ).resolves.toBeUndefined();

    expect(text()).toContain('resolution: live');
    // org + school groups; admin + resolved user; one program.
    expect(text()).toContain('groups=2 users=2 programs=1');
    expect(text()).toContain('groups: 7');
    expect(text()).toContain('[projection]');
    // Counts ran only against the two connected stores; others skipped.
    expect(text()).toContain('no connection (--url)');
    const countCalls = psqlCalls.filter((c) => c.sql.startsWith('SELECT count(*)'));
    expect(new Set(countCalls.map((c) => c.conn))).toEqual(new Set(['postgres://iam', 'postgres://pgm']));
  });

  it('ads-adm live: adm_attendance counts by programIds; period_attendance_status reads UNRESOLVED, not empty', async () => {
    const SCHOOL = 'b39f3ea1-0ee5-5a61-afdd-65e8c2b30db6';
    const USER = '92c6c9f4-c764-519f-9873-7df7b77f5410';
    const PROGRAM = 'ea1562ee-a620-5d5c-82a8-768da7f798c2';
    installEnvPsql((conn, sql) => {
      if (sql.startsWith('SELECT id FROM groups')) return [[SCHOOL]];
      if (sql.includes('DISTINCT user_id')) return [[USER]];
      if (sql.startsWith('SELECT id FROM "Program"')) return [[PROGRAM]];
      if (sql.startsWith('SELECT count(*)')) return [['7']];
      throw new Error(`unexpected sql: ${sql}`);
    });

    await expect(
      EnvOrgStatus.run(
        ['--org', 'emptyOrg', '--url', 'iam=postgres://iam', '--url', 'programs=postgres://pgm', '--url', 'ads-adm=postgres://ads'],
        config,
      ),
    ).resolves.toBeUndefined();

    expect(text()).toContain('adm_attendance: 7');
    // periodIds is a deeper ring status never resolves — the skip must say
    // UNRESOLVED, not read like a resolved-and-empty id-set.
    expect(text()).toContain('period_attendance_status: — (periodIds not resolved by status)');
    expect(psqlCalls.some((c) => c.sql.includes('period_attendance_status'))).toBe(false);
  });

  it("bad --url shapes are refused with the store-key list", async () => {
    await expect(
      EnvOrgStatus.run(['--org', 'emptyOrg', '--url', 'nope=postgres://x'], config),
    ).rejects.toThrow(/expected <store>=<connString>/);
  });
});
