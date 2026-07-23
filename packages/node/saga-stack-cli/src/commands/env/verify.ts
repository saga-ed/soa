/**
 * `saga-stack env verify` — health gate for a DEPLOYED shared environment
 * (soa#355): the `stack verify` analogue for dev / training.
 *
 * Where `stack verify` probes the local mesh from the manifest, this probes the
 * deployed hosts — and it judges health from the RESPONSE BODY, not the status
 * code. That is not stylistic: `*.wootdev.com` / `*.saga-training.org` are
 * wildcard DNS onto the shared ALB, whose default action answers **200 with the
 * body `dev-account-alb`** for any unmatched host, so a status-only gate reports
 * services that do not exist as healthy (verified live 2026-07-21). The body
 * classifier in `core/env/services.ts` is the actual gate.
 *
 *   default            probe every deployed service; NON-ZERO exit if a required
 *                      one is unhealthy. Services with no public route are
 *                      reported as such, never silently green.
 *   --tolerate <ids>   a listed service being down does not fail the gate
 *                      (`stack verify`'s flag, same spirit).
 *   --org <slug>       ALSO assert the fixture org's seed skeleton over the iam
 *                      connection (`--url iam=…`) — "is this org usable?" as
 *                      opposed to "are the services up?".
 *
 *   ss env verify --env dev
 *   ss env verify --env training --tolerate connect-api,rtsm-api
 *   ss env verify --env dev --org emptyOrg --url iam=postgres://…15432/iam
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, red, yellow } from '../../color.js';
import {
  ECS_CLUSTERS,
  ENV_NAMES,
  RESETTABLE_ORGS,
  RESET_GUARD_SQL,
  accountMismatchError,
  buildEnvHealthProbes,
  classifyEcsState,
  classifyProbeBody,
  resolveEnv,
  resolveFixtureOrg,
  verdictReason,
} from '../../core/env/index.js';
import type { EcsServiceState } from '../../core/env/index.js';
import { resolveCallerAccount } from '../../runtime/index.js';

interface ServiceReport {
  id: string;
  url: string | null;
  status: number | null;
  healthy: boolean;
  optional: boolean;
  tolerated: boolean;
  /** Why it is not healthy (empty when healthy). */
  reason: string;
  note?: string;
  /** --ecs only: the platform verdict for this service. */
  ecs?: { healthy: boolean; summary: string };
}

export default class EnvVerify extends BaseCommand {
  static description =
    "Health-gate a deployed shared environment (dev/training): probe every service's health endpoint and judge it by RESPONSE BODY (the shared ALB answers 200 for unrouted hosts). Non-zero exit if a required service is unhealthy. --org additionally asserts a fixture org's seed skeleton.";

  static examples = [
    '<%= config.bin %> <%= command.id %> --env dev',
    '<%= config.bin %> <%= command.id %> --env training --tolerate connect-api,rtsm-api',
    '<%= config.bin %> <%= command.id %> --env dev --org emptyOrg --url iam=postgres://…15432/iam',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    env: Flags.string({ description: `target environment (${ENV_NAMES.join(' | ')})`, default: 'dev' }),
    tolerate: Flags.string({
      description: 'comma-separated service ids whose being down does NOT fail the gate.',
    }),
    org: Flags.string({
      description: `also assert this fixture org's seed skeleton (${Object.keys(RESETTABLE_ORGS).join(' | ')}); needs --url iam=<conn>.`,
    }),
    url: Flags.string({ description: 'store connection as <store>=<connString> (only iam is used, for --org).', multiple: true }),
    ecs: Flags.boolean({
      description:
        'ALSO check the ECS platform state (running/desired tasks, rollout) — the truth HTTP cannot see (crash-loops behind a healthy target, stuck deploys). Covers services with no public route. Needs dev-account AWS credentials.',
      default: false,
    }),
    profile: Flags.string({ description: 'AWS profile for --ecs (defaults to the ambient chain).' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvVerify);
    const env = resolveEnv(flags.env);
    if (env === undefined) this.error(`unknown --env '${flags.env}' — expected one of: ${ENV_NAMES.join(', ')}`);

    const tolerated = new Set(
      (flags.tolerate ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    );

    // ── probe every deployed service (concurrently) ──
    const prober = this.getProber();
    const probes = buildEnvHealthProbes(env.domain, env.name);
    const reports: ServiceReport[] = await Promise.all(
      probes.map(async (p): Promise<ServiceReport> => {
        const base = { id: p.id, optional: p.optional, tolerated: tolerated.has(p.id), note: p.note };
        if (p.url === null) {
          // No public route — HTTP cannot verify it (ECS-only). Never green.
          return { ...base, url: null, status: null, healthy: false, reason: 'no public route (not HTTP-verifiable)' };
        }
        const res = await prober.probe(p.url);
        if (!res.ok) {
          return {
            ...base,
            url: p.url,
            status: res.status ?? null,
            healthy: false,
            reason: res.status === undefined ? 'unreachable (transport error/timeout)' : `HTTP ${res.status}`,
          };
        }
        const verdict = classifyProbeBody(res.body, p.kind);
        return {
          ...base,
          url: p.url,
          status: res.status ?? null,
          healthy: verdict === 'healthy',
          reason: verdict === 'healthy' ? '' : verdictReason(verdict),
        };
      }),
    );

    // ── optional ECS platform pass ──
    if (flags.ecs) {
      const aws = this.getEnvAws();
      const opts = { profile: flags.profile, region: env.awsRegion };
      const mismatch = accountMismatchError(await resolveCallerAccount(aws, opts), [env.awsAccountId], `'${env.name}'`);
      if (mismatch !== null) this.error(mismatch);
      for (const report of reports) {
        const probe = probes.find((p) => p.id === report.id);
        if (probe?.ecsService === undefined) continue; // Amplify frontends / not deployed
        const serviceName = `${probe.ecsService}-${env.ledgerIdentifier}`;
        let state: EcsServiceState | undefined;
        for (const cluster of ECS_CLUSTERS) {
          const found = (await aws.json(
            [
              'ecs',
              'describe-services',
              '--cluster',
              cluster,
              '--services',
              serviceName,
              '--query',
              'services[0].{running:runningCount,desired:desiredCount,status:status,rollout:deployments[0].rolloutState,taskDef:taskDefinition}',
            ],
            opts,
          )) as EcsServiceState | null;
          if (found !== null && found.status !== undefined) {
            state = found;
            break;
          }
        }
        const verdict = classifyEcsState(state);
        report.ecs = verdict;
        // A service HTTP said nothing about (no public route) is now judged by ECS.
        if (report.url === null && verdict.healthy) {
          report.healthy = true;
          report.reason = '';
        } else if (!verdict.healthy) {
          report.healthy = false;
          report.reason = report.reason === '' ? `ECS: ${verdict.summary}` : `${report.reason}; ECS: ${verdict.summary}`;
        }
      }
    }

    // ── optional org-skeleton assertion ──
    let orgReport: { slug: string; skeletonIntact: boolean; detail: string } | undefined;
    if (flags.org !== undefined) {
      const org = resolveFixtureOrg(flags.org);
      if (org === undefined) {
        this.error(
          `'${flags.org}' is not a known fixture org. Known slugs: ${Object.keys(RESETTABLE_ORGS).join(', ')}.`,
        );
      }
      const iamUrl = (flags.url ?? []).find((u) => u.startsWith('iam='))?.slice('iam='.length);
      if (iamUrl === undefined || iamUrl.trim() === '') {
        this.error(`--org needs the iam connection: pass --url iam=<connString> (from \`ss env connect iam\`).`);
      }
      const psql = this.getEnvPsql();
      const orgRow = await psql.query(iamUrl, RESET_GUARD_SQL.orgRow(org.orgId));
      const adminRow = await psql.query(iamUrl, RESET_GUARD_SQL.adminUser(org.adminUserId));
      const membRow = await psql.query(iamUrl, RESET_GUARD_SQL.adminMembership(org.adminMembershipId));
      const okOrg = orgRow[0]?.[0] === org.displayName;
      const okAdmin = adminRow[0]?.[0] === org.adminSlug;
      const okMemb = membRow.length === 1;
      const missing = [!okOrg ? 'org row' : '', !okAdmin ? 'admin user' : '', !okMemb ? 'admin membership' : ''].filter(
        (m) => m !== '',
      );
      orgReport = {
        slug: org.slug,
        skeletonIntact: missing.length === 0,
        detail: missing.length === 0 ? `org row + admin ${org.adminEmail} + membership present` : `MISSING: ${missing.join(', ')}`,
      };
    }

    // ── verdict: required + untolerated failures fail the gate ──
    const failures = reports.filter((r) => !r.healthy && !r.optional && !r.tolerated);
    const orgFailed = orgReport !== undefined && !orgReport.skeletonIntact;

    // ── render ──
    const idW = Math.max(...reports.map((r) => r.id.length));
    const lines: string[] = [
      `${bold('▶ env verify')} — ${bold(cyan(env.name))} ${dim(`(*.${env.domain}; health judged by response body)`)}`,
    ];
    for (const r of reports) {
      const id = r.id.padEnd(idW);
      if (r.healthy) {
        const detail = r.ecs !== undefined ? `${r.url ?? 'no public route'} ${dim(`· ecs ${r.ecs.summary}`)}` : (r.url ?? '');
        lines.push(`  ${green('✓')} ${id}  ${dim(detail)}`);
        continue;
      }
      const soft = r.optional || r.tolerated;
      const mark = soft ? yellow('○') : red('✗');
      const why = r.tolerated ? `${r.reason} ${dim('(tolerated)')}` : r.optional ? `${r.reason} ${dim('(optional)')}` : r.reason;
      lines.push(`  ${mark} ${id}  ${soft ? dim(why) : yellow(why)}`);
      if (r.note !== undefined) lines.push(`    ${dim(r.note)}`);
    }
    if (orgReport !== undefined) {
      lines.push(
        `  ${orgReport.skeletonIntact ? green('✓') : red('✗')} ${bold('org')} ${cyan(orgReport.slug)}  ${orgReport.skeletonIntact ? dim(orgReport.detail) : yellow(orgReport.detail)}`,
      );
    }
    const healthyCount = reports.filter((r) => r.healthy).length;
    lines.push(
      failures.length === 0 && !orgFailed
        ? `${green('✓ verify passed')} — ${bold(String(healthyCount))}/${bold(String(reports.length))} service(s) healthy${orgReport !== undefined ? ', org skeleton intact' : ''}.`
        : `${red('✗ verify FAILED')} — ${bold(String(failures.length))} required service(s) unhealthy${orgFailed ? ' + org skeleton broken' : ''} (${healthyCount}/${reports.length} healthy).`,
    );

    this.emit(
      flags,
      { env: env.name, services: reports, org: orgReport ?? null, healthy: healthyCount, failures: failures.map((f) => f.id) },
      lines,
    );

    if (failures.length > 0 || orgFailed) {
      this.error(
        `env verify FAILED for '${env.name}': ${failures.map((f) => f.id).join(', ') || 'org skeleton'}` +
          ` — see the report above. Use --tolerate <ids> to accept known-down services.`,
      );
    }
  }
}
