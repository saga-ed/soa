/**
 * `saga-stack env connect <store>` — open an SSM data-plane tunnel to a shared
 * environment's Postgres and hand back a ready connection string (soa#355,
 * Phase 0 — read-only; the tunnel itself mutates nothing).
 *
 * RESOLUTION — from the service's own live task definition, which is what
 * makes this self-maintaining across environments and store moves (verified
 * live on dev 2026-07-21: iam/program-hub/coach carry a `DATABASE_URL` secret;
 * ads-adm uses split `POSTGRES_*` env + a password secret; targets range from
 * db-host-v2 CloudMap DNS like `rostering-iam-canonical.dbs-v2.local:5440` to
 * the shared RDS):
 *
 *   1. ECS service `<store.ecsService>-<env.ledgerIdentifier>` looked up across
 *      the env's shared clusters (`env.ecsClusters`).
 *   2. Its task definition yields either the DATABASE_URL secret or the split
 *      POSTGRES_* fields (`core/env/taskdef.ts`); referenced secrets are
 *      fetched (Secrets Manager or SSM parameter refs both handled).
 *   3. Jump host = newest running EC2 tagged `Name=<env.jumpHostNameTag>` that
 *      is Online in SSM; CloudMap `.<env.dbHostNamespace>` names resolve THERE.
 *
 * REACHABILITY branches on the env's DATA-PLANE STYLE (`core/env/data-plane.ts`,
 * I#375), never on its name:
 *
 *   'db-host-cloudmap' (dev, training) — a `.<dbHostNamespace>` target is a DB
 *      CONTAINER the shared jump host's SG cannot reach, so the tunnel goes via
 *      the container's own EC2 host with a 127.0.0.1 dial (step 3 above).
 *   'rds-endpoint' (prod) — no db-host fleet: the task definition still supplies
 *      the DATABASE and USER, but the address dialled is the shared Postgres
 *      endpoint read at RUN TIME from `env.postgresEndpointParams` (SSM), and the
 *      jump host forwards straight to it. Nothing about it is hardcoded here.
 *
 * An env that declares `productionDataPlane` additionally REFUSES the read-only
 * Observer tier (read-only `list`/`discover`/`verify` still accept it) and
 * banners its human output; `--print-only` is the documented habit there.
 *
 * `--host/--remote-port/--database/--username` skip resolution entirely;
 * `--print-only` stops before the tunnel. Once the session-manager plugin
 * reports listening, prints a rewritten `DATABASE_URL` (127.0.0.1:local-port)
 * and HOLDS until Ctrl-C — the tunnel dies with the command. Requires
 * app-infra tier (SagaCap-SSMPortForward) or app-deploy. Postgres-first;
 * Mongo (needs `directConnection=true` through tunnels) is a follow-up.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import {
  ENV_NAMES,
  STORES,
  accountMismatchError,
  connectTierRefusal,
  dataPlaneStyle,
  extractDbTarget,
  localUrl,
  parseDatabaseUrl,
  resolveEnv,
} from '../../core/env/index.js';
import type { DeployedEnv, SecretRef, TaskDefContainer } from '../../core/env/index.js';
import { bold, cyan, dim, green, yellow } from '../../color.js';
import { resolveCallerAccount, resolveCallerArn, resolveJumpHost } from '../../runtime/index.js';

interface ResolvedTarget {
  host: string;
  port: number;
  database: string;
  username?: string;
  password?: string;
  source: string;
}

export default class EnvConnect extends BaseCommand {
  static description =
    "Open an SSM port-forward to a shared environment's Postgres, resolved from the service's live ECS task definition, and print a ready DATABASE_URL. Holds until Ctrl-C; --print-only resolves without connecting.";

  static examples = [
    '<%= config.bin %> <%= command.id %> iam --env dev --profile dev_admin',
    '<%= config.bin %> <%= command.id %> programs --env dev --local-port 15433',
    '<%= config.bin %> <%= command.id %> iam --host mydb.dbs-v2.local --remote-port 5440 --database rostering-iam-canonical --print-only',
    // Production: --print-only FIRST — resolve and look before opening anything
    // (Observer is refused here; the endpoint is read live from SSM).
    '<%= config.bin %> <%= command.id %> iam --env prod --print-only',
    '<%= config.bin %> <%= command.id %> iam --env prod --local-port 15442',
  ];

  static args = {
    store: Args.string({
      description: `store key (${STORES.map((s) => s.key).join(' | ')})`,
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    env: Flags.string({ description: `target environment (${ENV_NAMES.join(' | ')})`, default: 'dev' }),
    profile: Flags.string({ description: 'AWS profile to use (defaults to the ambient credential chain).' }),
    host: Flags.string({ description: 'remote DB endpoint (skips task-definition resolution).' }),
    'remote-port': Flags.integer({ description: 'remote DB port (with --host)', default: 5432 }),
    'local-port': Flags.integer({ description: 'local end of the tunnel', default: 15432 }),
    username: Flags.string({ description: 'override the resolved user (URL carries no password then).' }),
    database: Flags.string({ description: 'override the resolved database name.' }),
    'print-only': Flags.boolean({ description: 'resolve and print everything, but do not open the tunnel.', default: false }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvConnect);
    const env = resolveEnv(flags.env);
    if (env === undefined) this.error(`unknown --env '${flags.env}' — expected one of: ${ENV_NAMES.join(', ')}`);
    const store = STORES.find((s) => s.key === args.store);
    if (store === undefined && flags.host === undefined) {
      this.error(`unknown store '${args.store}' — expected one of: ${STORES.map((s) => s.key).join(', ')} (or pass --host)`);
    }
    const opts = { profile: flags.profile, region: env.awsRegion };

    // ── account preflight (see env list): fail actionably on the wrong account ──
    const mismatch = accountMismatchError(await resolveCallerAccount(this.getEnvAws(), opts), [env.awsAccountId], `'${env.name}'`);
    if (mismatch !== null) this.error(mismatch);

    // ── credential gate (I#375 Q5): a PRODUCTION data plane refuses the
    // read-only Observer tier before any resolution happens. Declared on the
    // env, so dev/training pay neither the extra sts call nor the refusal. ──
    if (env.productionDataPlane === true) {
      const refusal = connectTierRefusal(await resolveCallerArn(this.getEnvAws(), opts), env);
      if (refusal !== null) this.error(refusal);
      if (!flags['output-json'] && !flags.porcelain) {
        this.log(
          yellow(
            `⚠ this is PRODUCTION — '${env.name}' (${env.awsAccountId}/${env.domain}) holds real tenant data. ` +
              (flags['print-only'] ? 'Resolving only (--print-only).' : 'Prefer --print-only unless you mean to open a live tunnel.'),
          ),
        );
      }
    }

    // The reachability style this env's data plane needs — derived from the
    // registry (db-host fleet present or not), never from `env.name`.
    const style = dataPlaneStyle(env);

    // ── target resolution: explicit flags beat the task definition ──
    let target: ResolvedTarget;
    if (flags.host !== undefined) {
      target = {
        host: flags.host,
        port: flags['remote-port'],
        database: flags.database ?? store?.database ?? args.store,
        username: flags.username,
        source: '--host',
      };
    } else {
      const serviceName = `${store!.ecsService}-${env.ledgerIdentifier}`;
      target = await this.resolveFromTaskDef(env, serviceName, opts);
      // ── 'rds-endpoint' style: the task definition supplied the DATABASE and
      // USER (that is why it is still consulted), but the ADDRESS is the shared
      // Postgres endpoint discovered live from SSM — the task def may name a
      // private alias the jump host does not resolve, and the endpoint moves on
      // failover. `--host` (above) opts out of this too. ──
      if (style === 'rds-endpoint') {
        const rds = await this.resolveSharedEndpoint(env, opts);
        if (rds.host !== target.host || rds.port !== target.port) {
          this.log(
            `  ${dim('endpoint:')}  ${green(`${rds.host}:${rds.port}`)} ${dim(`(${rds.source}; task def named ${target.host}:${target.port})`)}`,
          );
        }
        target.host = rds.host;
        target.port = rds.port;
        target.source = `${target.source} + ${rds.source}`;
      }
      if (flags.database !== undefined) target.database = flags.database;
      if (flags.username !== undefined) {
        target.username = flags.username;
        target.password = undefined;
      }
    }

    // ── route: under the 'db-host-cloudmap' style a `.<namespace>` target
    // tunnels via the container's OWN host instance with a 127.0.0.1 dial (the
    // shared jump host's SG cannot reach the containers — task-SG allowlists).
    // Everything else — including EVERY 'rds-endpoint' target, which has no
    // namespace and no SG problem — dials from the shared jump host. ──
    let ssmTarget: string;
    let dialHost: string;
    let dialPort = target.port;
    let route: string;
    const namespace = style === 'db-host-cloudmap' ? env.dbHostNamespace : undefined;
    if (namespace !== undefined && target.host.endsWith(`.${namespace}`)) {
      const serviceName = target.host.slice(0, -(namespace.length + 1));
      const found = await this.discoverDbHostInstance(namespace, serviceName, opts);
      ssmTarget = found.instanceId;
      dialHost = '127.0.0.1';
      dialPort = found.port ?? target.port;
      route = `db-host ${found.instanceId} (CloudMap ${serviceName}, local dial :${dialPort})`;
    } else {
      const jump = await resolveJumpHost(this.getEnvAws(), env.jumpHostNameTag, opts);
      if (jump === undefined) {
        this.error(`no running+Online SSM jump host tagged Name=${env.jumpHostNameTag} — check tier/region/profile.`);
      }
      ssmTarget = jump;
      dialHost = target.host;
      route = `jump host ${jump}`;
    }

    const url = localUrl(target, flags['local-port']);
    this.log(`${bold('▶ env connect')} — ${bold(cyan(env.name))}${dim('/')}${cyan(args.store)}`);
    this.log(`  ${dim('target:')}    ${target.host}:${target.port}/${target.database} ${dim(`(${target.source})`)}`);
    this.log(`  ${dim('route:')}     ${route}`);
    if (flags['print-only']) {
      this.emit(
        flags,
        { env: env.name, store: args.store, host: target.host, port: target.port, database: target.database, ssmTarget, url },
        `DATABASE_URL=${url}`,
      );
      return;
    }

    const handle = this.getEnvAws().portForward({
      target: ssmTarget,
      host: dialHost,
      remotePort: dialPort,
      localPort: flags['local-port'],
      region: env.awsRegion,
      profile: flags.profile,
    });
    process.on('SIGINT', () => handle.stop());
    process.on('SIGTERM', () => handle.stop());
    await handle.ready;
    this.log(`${green('✓ tunnel up')} — 127.0.0.1:${bold(String(flags['local-port']))} → ${target.host}:${target.port}`);
    this.log(`  DATABASE_URL=${url}`); // left plain — meant to be copy-pasted
    this.log(`  ${dim(`psql '${url}'`)}`);
    this.log(dim('  (holding — Ctrl-C closes the tunnel)'));
    const code = await handle.exited;
    this.log(dim(`tunnel closed (${code ?? 'signal'}).`));
  }

  /** ECS service → task definition → DB target, secrets fetched through the aws seam. */
  private async resolveFromTaskDef(
    env: DeployedEnv,
    serviceName: string,
    opts: { profile?: string; region: string },
  ): Promise<ResolvedTarget> {
    const aws = this.getEnvAws();
    let taskDefArn: string | undefined;
    let clusterUsed: string | undefined;
    for (const cluster of env.ecsClusters) {
      const described = (await aws.json(
        ['ecs', 'describe-services', '--cluster', cluster, '--services', serviceName, '--query', 'services[0].taskDefinition'],
        opts,
      )) as string | null;
      this.log(
        `  ${dim('service candidate')} ${cluster}/${serviceName}: ${described === null ? dim('not found') : green(described)}`,
      );
      if (described !== null) {
        taskDefArn = described;
        clusterUsed = cluster;
        break;
      }
    }
    if (taskDefArn === undefined) {
      this.error(
        `ECS service '${serviceName}' not found in ${env.ecsClusters.join(' or ')} — is the store deployed on this env? (--host overrides resolution)`,
      );
    }

    const td = (await aws.json(
      ['ecs', 'describe-task-definition', '--task-definition', taskDefArn, '--query', 'taskDefinition.containerDefinitions'],
      opts,
    )) as TaskDefContainer[] | null;
    const dbTarget = extractDbTarget(td ?? []);
    if (dbTarget === undefined) {
      this.error(`task definition ${taskDefArn} carries neither a DATABASE_URL secret nor POSTGRES_* env — cannot resolve.`);
    }

    if (dbTarget.shape === 'url') {
      const raw = await this.fetchSecret(dbTarget.urlSecret, opts);
      const parsed = parseDatabaseUrl(raw);
      return { ...parsed, source: `${clusterUsed}/${serviceName} DATABASE_URL secret` };
    }
    const password = dbTarget.passwordSecret === undefined ? undefined : await this.fetchSecret(dbTarget.passwordSecret, opts);
    return {
      host: dbTarget.host,
      port: dbTarget.port,
      database: dbTarget.database,
      username: dbTarget.username,
      password,
      source: `${clusterUsed}/${serviceName} POSTGRES_* env`,
    };
  }

  /**
   * The 'rds-endpoint' style's address: the env's shared Postgres endpoint +
   * port, read at RUN TIME from the SSM parameters the registry NAMES (never
   * from a stored value — the endpoint changes on failover/rotation and must
   * not be able to drift out of a CLI release).
   */
  private async resolveSharedEndpoint(
    env: DeployedEnv,
    opts: { profile?: string; region: string },
  ): Promise<{ host: string; port: number; source: string }> {
    const params = env.postgresEndpointParams;
    if (params === undefined) {
      this.error(
        `'${env.name}' has no db-host fleet and declares no postgres endpoint parameters — ` +
          'nothing to discover. Pass --host (and --remote-port) to name the endpoint yourself.',
      );
    }
    const host = await this.fetchParam(params.endpoint, opts);
    const portRaw = await this.fetchParam(params.port, opts);
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) {
      this.error(`SSM ${params.port} is not a port number ('${portRaw}') — pass --remote-port to override.`);
    }
    return { host, port, source: `SSM ${params.endpoint}` };
  }

  /** One plain SSM parameter value (endpoint discovery — nothing encrypted here). */
  private async fetchParam(name: string, opts: { profile?: string; region: string }): Promise<string> {
    const value = (await this.getEnvAws().json(
      ['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value'],
      opts,
    )) as string | null;
    if (value === null || value === '') {
      this.error(`SSM parameter ${name} resolved to nothing — is the tier/profile right for this env?`);
    }
    return value;
  }

  /** CloudMap discover-instances → the db container's EC2 host + registered port. */
  private async discoverDbHostInstance(
    namespace: string,
    serviceName: string,
    opts: { profile?: string; region: string },
  ): Promise<{ instanceId: string; port?: number }> {
    const aws = this.getEnvAws();
    const discovered = (await aws.json(
      ['servicediscovery', 'discover-instances', '--namespace-name', namespace, '--service-name', serviceName],
      opts,
    )) as { Instances?: { Attributes?: Record<string, string> }[] } | null;
    const attrs = discovered?.Instances?.[0]?.Attributes;
    const ip = attrs?.AWS_INSTANCE_IPV4;
    if (ip === undefined) {
      this.error(`CloudMap has no instance for ${serviceName}.${namespace} — is the DB container up?`);
    }
    const ids = (await aws.json(
      [
        'ec2',
        'describe-instances',
        '--filters',
        `Name=private-ip-address,Values=${ip}`,
        '--query',
        'Reservations[].Instances[].InstanceId',
      ],
      opts,
    )) as string[] | null;
    const instanceId = (ids ?? [])[0];
    if (instanceId === undefined) this.error(`no EC2 instance owns db-host IP ${ip} — CloudMap record stale?`);
    const port = attrs?.AWS_INSTANCE_PORT;
    return { instanceId, port: port === undefined ? undefined : Number(port) };
  }

  /** Fetch a container-secret reference: Secrets Manager value or SSM parameter. */
  private async fetchSecret(ref: SecretRef, opts: { profile?: string; region: string }): Promise<string> {
    const aws = this.getEnvAws();
    const value =
      ref.kind === 'ssm'
        ? ((await aws.json(
            ['ssm', 'get-parameter', '--name', ref.valueFrom, '--with-decryption', '--query', 'Parameter.Value'],
            opts,
          )) as string | null)
        : ((await aws.json(
            ['secretsmanager', 'get-secret-value', '--secret-id', ref.valueFrom, '--query', 'SecretString'],
            opts,
          )) as string | null);
    if (value === null) this.error(`secret ${ref.valueFrom} resolved to nothing`);
    return value;
  }
}
