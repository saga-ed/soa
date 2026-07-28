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
 *      the shared clusters (`dev-shared-arm`, `dev-shared`).
 *   2. Its task definition yields either the DATABASE_URL secret or the split
 *      POSTGRES_* fields (`core/env/taskdef.ts`); referenced secrets are
 *      fetched (Secrets Manager or SSM parameter refs both handled).
 *   3. Jump host = newest running EC2 tagged `Name=dev-shared-ecs-instance`
 *      that is Online in SSM; CloudMap `.dbs-v2.local` names resolve THERE.
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
  DB_HOST_CLOUDMAP_NAMESPACE,
  ECS_CLUSTERS,
  ENV_NAMES,
  JUMP_HOST_NAME_TAG,
  STORES,
  accountMismatchError,
  extractDbTarget,
  localUrl,
  parseDatabaseUrl,
  resolveEnv,
} from '../../core/env/index.js';
import type { SecretRef, TaskDefContainer } from '../../core/env/index.js';
import { bold, cyan, dim, green } from '../../color.js';
import { resolveCallerAccount, resolveJumpHost } from '../../runtime/index.js';

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
      target = await this.resolveFromTaskDef(serviceName, opts);
      if (flags.database !== undefined) target.database = flags.database;
      if (flags.username !== undefined) {
        target.username = flags.username;
        target.password = undefined;
      }
    }

    // ── route: db-host-v2 CloudMap targets tunnel via the container's OWN host
    // instance with a 127.0.0.1 dial (the shared jump host's SG cannot reach the
    // containers — task-SG allowlists); everything else via the shared jump host. ──
    let ssmTarget: string;
    let dialHost: string;
    let dialPort = target.port;
    let route: string;
    if (target.host.endsWith(`.${DB_HOST_CLOUDMAP_NAMESPACE}`)) {
      const serviceName = target.host.slice(0, -(DB_HOST_CLOUDMAP_NAMESPACE.length + 1));
      const found = await this.discoverDbHostInstance(serviceName, opts);
      ssmTarget = found.instanceId;
      dialHost = '127.0.0.1';
      dialPort = found.port ?? target.port;
      route = `db-host ${found.instanceId} (CloudMap ${serviceName}, local dial :${dialPort})`;
    } else {
      const jump = await resolveJumpHost(this.getEnvAws(), JUMP_HOST_NAME_TAG, opts);
      if (jump === undefined) {
        this.error(`no running+Online SSM jump host tagged Name=${JUMP_HOST_NAME_TAG} — check tier/region/profile.`);
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
    serviceName: string,
    opts: { profile?: string; region: string },
  ): Promise<ResolvedTarget> {
    const aws = this.getEnvAws();
    let taskDefArn: string | undefined;
    let clusterUsed: string | undefined;
    for (const cluster of ECS_CLUSTERS) {
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
        `ECS service '${serviceName}' not found in ${ECS_CLUSTERS.join(' or ')} — is the store deployed on this env? (--host overrides resolution)`,
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

  /** CloudMap discover-instances → the db container's EC2 host + registered port. */
  private async discoverDbHostInstance(
    serviceName: string,
    opts: { profile?: string; region: string },
  ): Promise<{ instanceId: string; port?: number }> {
    const aws = this.getEnvAws();
    const discovered = (await aws.json(
      ['servicediscovery', 'discover-instances', '--namespace-name', DB_HOST_CLOUDMAP_NAMESPACE, '--service-name', serviceName],
      opts,
    )) as { Instances?: { Attributes?: Record<string, string> }[] } | null;
    const attrs = discovered?.Instances?.[0]?.Attributes;
    const ip = attrs?.AWS_INSTANCE_IPV4;
    if (ip === undefined) {
      this.error(`CloudMap has no instance for ${serviceName}.${DB_HOST_CLOUDMAP_NAMESPACE} — is the DB container up?`);
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
