/**
 * `saga-stack env discover` — walk an environment's SSM parameter roots and
 * surface the data-plane wiring (soa#355, Phase 0 — read-only).
 *
 * The registry deliberately hardcodes no endpoint that can drift; this command
 * is how the live values are found: it pages `ssm get-parameters-by-path` under
 * the env's discovery roots, filters to data-store-shaped names, and resolves
 * the SSM jump host (EC2 tag `Name=dev-shared-ecs-instance`, Online only) that
 * `env connect` tunnels through. Use it once per session to fill/verify the
 * values `env connect` needs.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, red } from '../../color.js';
import { ENV_NAMES, JUMP_HOST_NAME_TAG, accountMismatchError, resolveEnv } from '../../core/env/index.js';
import { resolveCallerAccount, resolveJumpHost } from '../../runtime/index.js';

const DEFAULT_FILTER = 'postgres|mongo|mongodb|db-host|rabbit|redis|rds|secret';

interface SsmParam {
  Name?: string;
  Type?: string;
}

export default class EnvDiscover extends BaseCommand {
  static description =
    "Discover a shared environment's data-plane wiring: SSM params under its discovery roots (filtered to data-store names) and the Online SSM jump host. Read-only.";

  static examples = [
    '<%= config.bin %> <%= command.id %> --env dev --profile dev_admin',
    '<%= config.bin %> <%= command.id %> --env dev --filter mongodb',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    env: Flags.string({ description: `target environment (${ENV_NAMES.join(' | ')})`, default: 'dev' }),
    profile: Flags.string({ description: 'AWS profile to use (defaults to the ambient credential chain).' }),
    filter: Flags.string({
      description: 'case-insensitive regex over parameter names',
      default: DEFAULT_FILTER,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvDiscover);
    const env = resolveEnv(flags.env);
    if (env === undefined) this.error(`unknown --env '${flags.env}' — expected one of: ${ENV_NAMES.join(', ')}`);
    const aws = this.getEnvAws();
    const opts = { profile: flags.profile, region: env.awsRegion };
    const filter = new RegExp(flags.filter, 'i');

    // ── account preflight (see env list): fail actionably on the wrong account ──
    const mismatch = accountMismatchError(await resolveCallerAccount(aws, opts), [env.awsAccountId], `'${env.name}'`);
    if (mismatch !== null) this.error(mismatch);

    // ── SSM parameters under each discovery root (paged) ──
    const params: { name: string; type: string }[] = [];
    for (const root of env.ssmDiscoveryRoots) {
      let nextToken: string | undefined;
      do {
        const args = [
          'ssm',
          'get-parameters-by-path',
          '--path',
          root,
          '--recursive',
          '--max-results',
          '10',
        ];
        if (nextToken !== undefined) args.push('--next-token', nextToken);
        const page = (await aws.json(args, opts)) as { Parameters?: SsmParam[]; NextToken?: string } | null;
        for (const p of page?.Parameters ?? []) {
          if (p.Name !== undefined && filter.test(p.Name)) params.push({ name: p.Name, type: p.Type ?? '' });
        }
        nextToken = page?.NextToken;
      } while (nextToken !== undefined);
    }
    params.sort((a, b) => a.name.localeCompare(b.name));

    // ── the SSM jump host (running + Online) ──
    const jump = await resolveJumpHost(aws, JUMP_HOST_NAME_TAG, opts);

    const lines: string[] = [
      `${bold('▶ env discover')} — ${bold(cyan(env.name))} ${dim(`(roots: ${env.ssmDiscoveryRoots.join(', ')}; filter: /${flags.filter}/i)`)}`,
      ...params.map((p) => `  ${p.name}  ${dim(`[${p.type}]`)}`),
      params.length === 0 ? dim('  (no matching parameters — check tier/filter)') : '',
      jump === undefined
        ? `  ${dim('jump host:')} ${red(`✗ no running+Online instance tagged Name=${JUMP_HOST_NAME_TAG}`)}`
        : `  ${dim('jump host:')} ${green(jump)} ${dim(`(tag Name=${JUMP_HOST_NAME_TAG}, Online)`)}`,
    ].filter((l) => l !== '');
    this.emit(flags, { env: env.name, parameters: params, jumpHost: jump ?? null }, lines);
  }
}
