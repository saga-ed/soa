/**
 * `saga-stack env org status` — one fixture org's data footprint across the
 * mesh's Postgres stores (soa#355, Phase 0 — read-only).
 *
 * The debug primitive AND, by construction, the dry-run half of the future
 * `env org reset`: it resolves the org's id-sets and counts org-linked rows
 * per store/table, marking event-materialized (projection) rows separately —
 * the orphan category that never self-heals.
 *
 * TARGETING: orgs are addressed by catalog SLUG only (`--org emptyOrg`); the
 * UUID is derived (uuidv5 seed-id scheme), never typed. Unknown slugs are
 * refused with the catalog listing — that is the structural guard that keeps
 * hand-built orgs (e.g. the training orgs) untargetable by mistake.
 *
 * ID RESOLUTION: the org id + admin ids come from the catalog offline. Group,
 * member-user, and program id-sets resolve LIVE from the two anchor stores
 * when their connections are given (`--url iam=…`, `--url programs=…` — from
 * `env connect`); without them the footprint runs in `partial-offline` mode
 * (catalog ids only) and says so per table. Live-resolved ids are UUID-validated
 * before they are ever inlined into SQL.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { bold, cyan, dim, green, yellow } from '../../../color.js';
import {
  RESETTABLE_ORGS,
  RESOLVE_SQL,
  STORES,
  assertUuids,
  countSql,
  resolveFixtureOrg,
} from '../../../core/env/index.js';
import type { OrgIdSets, StoreFootprint } from '../../../core/env/index.js';

export default class EnvOrgStatus extends BaseCommand {
  static description =
    "Show a fixture org's data footprint across the mesh's Postgres stores (per-table row counts, projections marked). Read-only; targets orgs by catalog slug only.";

  static examples = [
    '<%= config.bin %> <%= command.id %> --org emptyOrg --url iam=postgres://…15432/iam --url programs=postgres://…15433/programs',
    '<%= config.bin %> <%= command.id %> --org emptyOrg --offline',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    org: Flags.string({ description: `fixture org slug (${Object.keys(RESETTABLE_ORGS).join(' | ')})`, required: true }),
    url: Flags.string({
      description: 'store connection as <store>=<connString> (repeatable; store keys: ' + STORES.map((s) => s.key).join(', ') + ')',
      multiple: true,
    }),
    offline: Flags.boolean({
      description: 'catalog-derived ids only — no live id resolution even if anchor URLs are given.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvOrgStatus);
    const org = resolveFixtureOrg(flags.org);
    if (org === undefined) {
      this.error(
        `'${flags.org}' is not a resettable fixture org. Known slugs: ${Object.keys(RESETTABLE_ORGS).join(', ')}. ` +
          'Orgs outside the seed catalog (e.g. hand-built training orgs) are deliberately untargetable.',
      );
    }

    const urls = new Map<string, string>();
    for (const entry of flags.url ?? []) {
      const eq = entry.indexOf('=');
      const key = eq === -1 ? '' : entry.slice(0, eq);
      if (eq === -1 || STORES.every((s) => s.key !== key)) {
        this.error(`bad --url '${entry}' — expected <store>=<connString> with store one of: ${STORES.map((s) => s.key).join(', ')}`);
      }
      urls.set(key, entry.slice(eq + 1));
    }

    const psql = this.getEnvPsql();

    // ── id-set resolution: catalog offline, anchors live when reachable ──
    const ids: OrgIdSets = {
      orgId: org.orgId,
      groupIds: [org.orgId], // the district group row IS the org anchor row
      userIds: [org.adminUserId],
      programIds: [],
    };
    let resolution: 'live' | 'partial-offline' = 'partial-offline';
    const iamUrl = urls.get('iam');
    const programsUrl = urls.get('programs');
    if (!flags.offline && iamUrl !== undefined && programsUrl !== undefined) {
      const groupRows = await psql.query(iamUrl, RESOLVE_SQL.groupIds(org.orgId));
      const groupIds = groupRows.map((r) => r[0] ?? '');
      assertUuids(groupIds, 'live groupIds');
      // The district row itself carries org_id = its own id; keep the anchor present even if absent live.
      ids.groupIds = [...new Set([org.orgId, ...groupIds])];
      const userRows = ids.groupIds.length === 0 ? [] : await psql.query(iamUrl, RESOLVE_SQL.userIds(ids.groupIds));
      const userIds = userRows.map((r) => r[0] ?? '');
      assertUuids(userIds, 'live userIds');
      ids.userIds = [...new Set([org.adminUserId, ...userIds])];
      const programRows = await psql.query(programsUrl, RESOLVE_SQL.programIds(org.orgId));
      const programIds = programRows.map((r) => r[0] ?? '');
      assertUuids(programIds, 'live programIds');
      ids.programIds = programIds;
      resolution = 'live';
    }

    // ── per-store footprint ──
    const stores: StoreFootprint[] = [];
    for (const store of STORES) {
      const url = urls.get(store.key);
      const footprint: StoreFootprint = { store: store.key, service: store.service, tables: [] };
      for (const rule of store.tables) {
        if (url === undefined) {
          footprint.tables.push({ table: rule.table, projection: rule.projection === true, count: null, skipped: 'no connection (--url)' });
          continue;
        }
        const sql = countSql(rule, ids);
        if (sql === null) {
          // Distinguish "resolved and empty" from "status never resolves this
          // set" (deeper rings like periodIds are Phase 1 / reset territory) —
          // an unresolved set must not read as an empty one.
          const param = ids[rule.param];
          footprint.tables.push({
            table: rule.table,
            projection: rule.projection === true,
            count: null,
            skipped:
              param === undefined
                ? `${rule.param} not resolved by status`
                : `empty ${rule.param} id-set${resolution === 'partial-offline' ? ' (offline)' : ''}`,
          });
          continue;
        }
        const rows = await psql.query(url, sql);
        footprint.tables.push({ table: rule.table, projection: rule.projection === true, count: Number(rows[0]?.[0] ?? 0) });
      }
      stores.push(footprint);
    }

    // ── render (colour is TTY-gated in color.ts; plain text otherwise) ──
    const num = (n: number): string => (n > 0 ? bold(String(n)) : dim('0'));
    const resColor = resolution === 'live' ? green : yellow;
    const lines: string[] = [
      `${bold('▶ org status')} — ${bold(cyan(org.displayName))} ${dim(`(${org.slug})`)} ${dim(org.orgId)}`,
      `  ${dim('admin:')} ${org.adminEmail} ${dim(`(${org.adminUserId})`)}`,
      `  ${dim('resolution:')} ${resColor(resolution)}` +
        (resolution === 'partial-offline' ? dim(' — pass --url iam=… and --url programs=… for live id-sets') : ''),
      `  ${dim('id-sets:')} ${dim('groups=')}${num(ids.groupIds.length)} ${dim('users=')}${num(ids.userIds.length)} ${dim('programs=')}${num(ids.programIds.length)}`,
    ];
    let total = 0;
    for (const s of stores) {
      const connected = s.tables.some((t) => t.count !== null);
      lines.push(
        `  ${bold(cyan(s.store))} ${dim(`(${s.service})`)}${connected ? '' : dim(' — skipped, no connection')}`,
      );
      for (const t of s.tables) {
        const mark = t.projection ? dim(' [projection]') : '';
        if (t.count === null) {
          lines.push(`    ${t.table}${mark}: ${dim(`— (${t.skipped ?? 'skipped'})`)}`);
        } else {
          total += t.count;
          lines.push(`    ${t.table}${mark}: ${num(t.count)}`);
        }
      }
    }
    lines.push(`${green('✓')} ${dim('footprint total:')} ${bold(String(total))} ${dim('row(s) across connected stores.')}`);
    this.emit(
      flags,
      { org: { slug: org.slug, orgId: org.orgId, adminEmail: org.adminEmail }, resolution, ids, stores, total },
      lines,
    );
  }
}
