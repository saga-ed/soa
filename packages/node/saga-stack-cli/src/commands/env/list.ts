/**
 * `saga-stack env list` — the deployed shared environments and their
 * control-plane footprint (soa#355, Phase 0 — read-only).
 *
 * For each registered env (dev = `*.wootdev.com`, training = `*.saga-training.org`)
 * queries the dev-platform Environment ledger (DynamoDB, one record per
 * identifier: `pk=ENV#<identifier>`, resource rows `sk=RES#<kind>#<id>`) and
 * summarizes the resource kinds. Requires an authenticated AWS session; the
 * observer tier CANNOT read the ledger (explicit deny) — an AccessDenied here
 * means "wrong tier", not "environment missing", and the error text says so.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, red } from '../../color.js';
import { DEPLOYED_ENVS, LEDGER_TABLE, accountMismatchError } from '../../core/env/index.js';
import { resolveCallerAccount } from '../../runtime/index.js';

interface LedgerItem {
  sk?: { S?: string };
}

export default class EnvList extends BaseCommand {
  static description =
    'List deployed shared environments (dev, training) and their dev-platform ledger footprint. Read-only.';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --profile dev_admin --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    profile: Flags.string({ description: 'AWS profile to use (defaults to the ambient credential chain).' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvList);
    const aws = this.getEnvAws();

    // ── account preflight: every env's ledger lives in the dev account; a run
    // pointed at the wrong account otherwise fails with a cryptic per-env
    // ResourceNotFoundException instead of "switch profile". ──
    const expectedAccounts = [...new Set(Object.values(DEPLOYED_ENVS).map((e) => e.awsAccountId))];
    const caller = await resolveCallerAccount(aws, { profile: flags.profile, region: 'us-west-2' });
    const mismatch = accountMismatchError(caller, expectedAccounts, 'the env ledger');
    if (mismatch !== null) this.error(mismatch);

    const rows: { name: string; identifier: string; domain: string; resources: Record<string, number>; error?: string }[] = [];
    for (const env of Object.values(DEPLOYED_ENVS)) {
      try {
        const result = (await aws.json(
          [
            'dynamodb',
            'query',
            '--table-name',
            LEDGER_TABLE,
            '--key-condition-expression',
            'pk = :pk',
            '--expression-attribute-values',
            JSON.stringify({ ':pk': { S: `ENV#${env.ledgerIdentifier}` } }),
            '--projection-expression',
            'sk',
          ],
          { profile: flags.profile, region: env.awsRegion },
        )) as { Items?: LedgerItem[] } | null;
        const resources: Record<string, number> = {};
        for (const item of result?.Items ?? []) {
          const sk = item.sk?.S ?? '';
          if (!sk.startsWith('RES#')) continue;
          const kind = sk.split('#')[1] ?? 'unknown';
          resources[kind] = (resources[kind] ?? 0) + 1;
        }
        rows.push({ name: env.name, identifier: env.ledgerIdentifier, domain: env.domain, resources });
      } catch (err) {
        const message = (err as Error).message;
        rows.push({
          name: env.name,
          identifier: env.ledgerIdentifier,
          domain: env.domain,
          resources: {},
          error: message.includes('AccessDenied')
            ? 'AccessDenied — the observer tier cannot read the ledger (wrong tier, not a missing env); use app-deploy/app-infra'
            : message,
        });
      }
    }

    const nameW = Math.max(...rows.map((r) => r.name.length));
    const domainW = Math.max(...rows.map((r) => r.domain.length + 2)); // '*.' + domain
    const SUB = '      '; // sub-line indent (description, ledger)

    const lines: string[] = [bold('Deployed shared environments'), ''];
    for (const r of rows) {
      const env = DEPLOYED_ENVS[r.name];
      const domain = `*.${r.domain}`;
      lines.push(
        `  ${bold(cyan(r.name.padEnd(nameW)))}  ${green(domain.padEnd(domainW))}  ${dim(`(${r.identifier})`)}`,
      );
      if (env !== undefined) lines.push(`${SUB}${dim(env.description)}`);
      if (r.error !== undefined) {
        lines.push(`${SUB}${dim('ledger')}  ${red(`✗ ${r.error}`)}`);
      } else {
        const kinds = Object.entries(r.resources)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, n]) => `${dim(`${k}×`)}${bold(String(n))}`)
          .join('  ');
        lines.push(`${SUB}${dim('ledger')}  ${kinds === '' ? dim('(no resource rows)') : kinds}`);
      }
      lines.push('');
    }
    if (lines[lines.length - 1] === '') lines.pop(); // drop trailing blank
    this.emit(flags, { environments: rows }, lines);
  }
}
