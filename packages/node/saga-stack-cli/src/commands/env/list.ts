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
 *
 * The ledger is a PER-ENV artifact (`env.ledgerTable`), not a global, so envs
 * are walked GROUPED BY TABLE: each group is queried with the credentials its
 * own table's account needs, and an env with no ledger table at all is a
 * legitimate group of its own — reported as "not ledger-tracked", never as an
 * error and never as a silent blank that reads like "zero resources" (I#375).
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, red } from '../../color.js';
import { DEPLOYED_ENVS, ENV_NAMES, accountMismatchError } from '../../core/env/index.js';
import type { DeployedEnv } from '../../core/env/index.js';
import { resolveCallerAccount } from '../../runtime/index.js';

interface LedgerItem {
  sk?: { S?: string };
}

/** Envs sharing one ledger table (or, with `table` undefined, sharing none). */
interface LedgerGroup {
  table: string | undefined;
  envs: DeployedEnv[];
}

interface EnvRow {
  name: string;
  identifier: string;
  domain: string;
  resources: Record<string, number>;
  error?: string;
  /**
   * Set ONLY for envs with no ledger table — the explicit, non-alarming
   * footprint line. Absent (not empty) for ledger-tracked envs, which keeps
   * their JSON shape exactly what it has always been.
   */
  ledgerNote?: string;
}

/**
 * Group the registry by ledger table, preserving registry order both between
 * groups (first appearance wins) and within them.
 */
function groupByLedgerTable(envs: readonly DeployedEnv[]): LedgerGroup[] {
  const groups: LedgerGroup[] = [];
  for (const env of envs) {
    const existing = groups.find((g) => g.table === env.ledgerTable);
    if (existing === undefined) groups.push({ table: env.ledgerTable, envs: [env] });
    else existing.envs.push(env);
  }
  return groups;
}

export default class EnvList extends BaseCommand {
  static description = `List deployed shared environments (${ENV_NAMES.join(', ')}) and their dev-platform ledger footprint. Read-only; an env with no ledger is listed without needing its account's credentials.`;

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

    const groups = groupByLedgerTable(Object.values(DEPLOYED_ENVS));

    // ── account preflight: scoped to the envs we will actually QUERY. A run
    // pointed at the wrong account otherwise fails with a cryptic per-env
    // ResourceNotFoundException instead of "switch profile" — but an env with
    // no ledger table needs no credentials at all, so it must not drag its
    // account into the expectation (nor be blocked by someone else's). ──
    const expectedAccounts = [
      ...new Set(groups.filter((g) => g.table !== undefined).flatMap((g) => g.envs.map((e) => e.awsAccountId))),
    ];
    if (expectedAccounts.length > 0) {
      const caller = await resolveCallerAccount(aws, { profile: flags.profile, region: 'us-west-2' });
      const mismatch = accountMismatchError(caller, expectedAccounts, 'the env ledger');
      if (mismatch !== null) this.error(mismatch);
    }

    const rows: EnvRow[] = [];
    for (const group of groups) {
      for (const env of group.envs) {
        const base = { name: env.name, identifier: env.ledgerIdentifier, domain: env.domain };
        if (group.table === undefined) {
          // Not an error and not a blank: the env genuinely has no ledger
          // footprint anywhere, and it costs NO credentials to say so.
          rows.push({
            ...base,
            resources: {},
            ledgerNote: `not ledger-tracked (${env.name} is not a dev-platform environment)`,
          });
          continue;
        }
        try {
          const result = (await aws.json(
            [
              'dynamodb',
              'query',
              '--table-name',
              group.table,
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
          rows.push({ ...base, resources });
        } catch (err) {
          const message = (err as Error).message;
          rows.push({
            ...base,
            resources: {},
            error: message.includes('AccessDenied')
              ? 'AccessDenied — the observer tier cannot read the ledger (wrong tier, not a missing env); use app-deploy/app-infra'
              : message,
          });
        }
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
      } else if (r.ledgerNote !== undefined) {
        lines.push(`${SUB}${dim('ledger')}  ${dim(r.ledgerNote)}`);
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
