/**
 * `saga-stack env org reset` — surgically delete ONE fixture org's data across
 * the shared environment's Postgres stores, back to the seeded skeleton
 * (soa#355, Phase 1 — the first destructive `env` command).
 *
 * Follows `stack wipe`'s destructive canon: `--dry-run` enumerates (per-table
 * DELETE counts, projections marked) and exits 0 touching nothing; a plain run
 * shows the same enumeration and prompts ONCE; `--yes` skips the prompt;
 * a declined prompt aborts with exit 0; hard refusals (unknown slug, missing
 * anchors, failed identity assertion) are non-zero via `this.error`.
 *
 * GUARD LADDER (all structural, none skippable by flags):
 *   1. slug-only targeting — orgs outside `RESETTABLE_ORGS` are untargetable.
 *   2. BOTH anchor stores connected (`--url iam=…` AND `--url programs=…`) —
 *      id-sets resolve live or not at all. Other stores without a `--url` are
 *      SKIPPED with loud warnings (their org rows survive).
 *   3. PRE-FLIGHT IDENTITY ASSERTION — the org group row must exist and carry
 *      the catalog display name, and the admin user must exist with the
 *      catalog email, or the whole run refuses: proof the connected database
 *      actually holds the seeded fixture org.
 *   4. Skeleton protection is IN the SQL (`core/env/reset-plan.ts`): the org
 *      row, admin user, admin membership, and seeded personas survive by
 *      explicit predicates on their deterministic ids; multi-org users are
 *      never deleted anywhere.
 *
 * `--snapshot` takes a best-effort restore point per store through the
 * db-host-v2 orchestrator Lambda BEFORE deleting (profile `pre-org-reset`,
 * versioned + immutable). Unreachable orchestrator / failed dump ⇒ WARN and
 * proceed (dev-only data; the seed skeleton is regenerable) — EXCEPT a
 * "not in registry" response, which means the target name is wrong and aborts
 * the reset. Stores whose registry name is unknown are warned and skipped
 * (`--snapshot-service <store>=<serviceName>` supplies it).
 *
 * Execution: one BEGIN/COMMIT transaction per store (single `psql -c`,
 * ON_ERROR_STOP — all-or-nothing per store), leaf stores first, iam last (the
 * resolution evidence dies at the very end). Then a post-verify recount per
 * table (before/after; leftovers flagged LOUD; tables whose delete predicate
 * would self-blind the recount are reported verify-indirect instead of a
 * structurally-zero number) and a skeleton check (org row + admin user +
 * admin membership still present) — a broken skeleton is a non-zero exit
 * after the full report is emitted.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { bold, cyan, dim, green, red, yellow } from '../../../color.js';
import {
  ENV_NAMES,
  ORCHESTRATOR_LAMBDA,
  RESETTABLE_ORGS,
  RESET_GUARD_SQL,
  RESET_RESOLVE_STEPS,
  RESET_STORE_KEYS,
  SNAPSHOT_PROFILE,
  assertSessionIds,
  assertUuids,
  buildResetPlan,
  initialResetIds,
  resolveEnv,
  resolveFixtureOrg,
} from '../../../core/env/index.js';
import type { ResetIdSets } from '../../../core/env/index.js';

/** One table's report row (before = pre-delete count, after = post-verify recount). */
interface TableReport {
  table: string;
  projection: boolean;
  before: number | null;
  after: number | null;
  /** The delete predicate self-blinds post-delete — no meaningful recount exists. */
  verify?: 'indirect';
  skipped?: string;
}

interface StoreReport {
  store: string;
  service: string;
  connected: boolean;
  tables: TableReport[];
}

interface SnapshotReport {
  store: string;
  service?: string;
  ok: boolean;
  /** Restore-point identity from the orchestrator's flat success body ({ok, name, profile, …}). */
  name?: string;
  profile?: string;
  skipped?: string;
  error?: string;
}

export default class EnvOrgReset extends BaseCommand {
  static description =
    "DELETE a fixture org's data across the shared environment's Postgres stores, back to the seeded skeleton (org row + admin + seeded personas survive). Destructive; slug-only targeting, identity-asserted, one confirm, per-store transactions, post-verified.";

  static examples = [
    '<%= config.bin %> <%= command.id %> --org emptyOrg --url iam=postgres://…15432/iam --url programs=postgres://…15433/programs --dry-run',
    '<%= config.bin %> <%= command.id %> --org emptyOrg --url iam=… --url programs=… --url sessions=… --url scheduling=… --yes',
    '<%= config.bin %> <%= command.id %> --org emptyOrg --url iam=… --url programs=… --snapshot --profile dev_admin',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    org: Flags.string({
      description: `fixture org slug (${Object.keys(RESETTABLE_ORGS).join(' | ')})`,
      required: true,
    }),
    url: Flags.string({
      description:
        'store connection as <store>=<connString> (repeatable; store keys: ' +
        RESET_STORE_KEYS.join(', ') +
        '). iam AND programs are mandatory anchors; other stores without a --url are skipped with a warning.',
      multiple: true,
    }),
    'dry-run': Flags.boolean({
      description:
        'resolve id-sets, run the identity assertion, and print exactly what would be deleted (per-table counts) — then exit 0 without deleting anything.',
      default: false,
    }),
    yes: Flags.boolean({
      description: 'non-interactive: skip the destructive-action prompt (CI / agents).',
      default: false,
    }),
    snapshot: Flags.boolean({
      description:
        `best-effort pre-delete snapshot per store via the db-host-v2 orchestrator (profile '${SNAPSHOT_PROFILE}', versioned). ` +
        'Unreachable orchestrator ⇒ warn and proceed; an unknown registry name skips that store (see --snapshot-service).',
      default: false,
    }),
    'snapshot-service': Flags.string({
      description: 'db-host-v2 registry serviceName override as <store>=<serviceName> (repeatable, with --snapshot).',
      multiple: true,
    }),
    env: Flags.string({ description: `target environment (${ENV_NAMES.join(' | ')})`, default: 'dev' }),
    profile: Flags.string({ description: 'AWS profile for the --snapshot Lambda call (defaults to the ambient chain).' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EnvOrgReset);
    const dry = flags['dry-run'];
    const human = !flags['output-json'] && !flags.porcelain;

    // ── guard 1: slug-only targeting (status's exact refusal) ──
    const org = resolveFixtureOrg(flags.org);
    if (org === undefined) {
      this.error(
        `'${flags.org}' is not a resettable fixture org. Known slugs: ${Object.keys(RESETTABLE_ORGS).join(', ')}. ` +
          'Orgs outside the seed catalog (e.g. hand-built training orgs) are deliberately untargetable.',
      );
    }
    const env = resolveEnv(flags.env);
    if (env === undefined) this.error(`unknown --env '${flags.env}' — expected one of: ${ENV_NAMES.join(', ')}`);
    if (flags.snapshot && env.name !== 'dev') {
      // ORCHESTRATOR_LAMBDA is the DEV control plane; both envs share an
      // account+region, so a training run would "successfully" snapshot dev's
      // databases while the deletes hit training — a wrong restore point is
      // worse than none.
      this.error(
        `--snapshot drives the dev db-host orchestrator ('${ORCHESTRATOR_LAMBDA}') and would snapshot dev's databases, ` +
          `not '${env.name}'s — no orchestrator exists for '${env.name}' yet. Re-run without --snapshot.`,
      );
    }

    // ── parse --url map against the RESET store keys ──
    const urls = new Map<string, string>();
    for (const entry of flags.url ?? []) {
      const eq = entry.indexOf('=');
      const key = eq === -1 ? '' : entry.slice(0, eq);
      if (eq === -1 || !RESET_STORE_KEYS.includes(key)) {
        this.error(`bad --url '${entry}' — expected <store>=<connString> with store one of: ${RESET_STORE_KEYS.join(', ')}`);
      }
      const conn = entry.slice(eq + 1);
      if (conn.trim() === '') {
        // An empty conn string would let psql fall back to libpq env-var
        // defaults (PGHOST/PGDATABASE/…) and silently retarget the run.
        this.error(`bad --url '${entry}' — empty connection string; pass a real conn (from \`ss env connect\`).`);
      }
      urls.set(key, conn);
    }

    // ── guard 2: both anchors, or nothing runs (dry-run included — the
    // enumeration is meaningless without live id-sets). ──
    const iamUrl = urls.get('iam');
    const programsUrl = urls.get('programs');
    if (iamUrl === undefined || programsUrl === undefined) {
      this.error(
        'env org reset requires BOTH anchor stores connected: pass --url iam=<conn> AND --url programs=<conn> ' +
          '(from `ss env connect`). Id-sets resolve live from the anchors or the reset does not run at all.',
      );
    }

    const psql = this.getEnvPsql();

    // ── id-set resolution (dependency order, all before ANY delete) ──
    const ids = initialResetIds(org);
    const resolveSkipStores = new Set<string>();
    for (const step of RESET_RESOLVE_STEPS) {
      const url = urls.get(step.store);
      if (url === undefined) {
        resolveSkipStores.add(step.store);
        continue;
      }
      const sql = step.sql(ids);
      if (sql === null) continue; // prerequisite set empty — nothing can exist
      const rows = await psql.query(url, sql);
      const values = rows.map((r) => r[0] ?? '').filter((v) => v.length > 0);
      if (step.set === 'sessionIds') assertSessionIds(values);
      else assertUuids(values, `live ${step.set}`);
      ids[step.set] = [...new Set([...ids[step.set], ...values])];
    }
    for (const store of resolveSkipStores) {
      this.warn(
        `⚠ store '${store}' has no --url — its id-resolution steps were SKIPPED; ` +
          'orphan ids sourced there will not be swept (dependent deletes may be incomplete).',
      );
    }

    // ── guard 3: pre-flight identity assertion (refuse-on-mismatch) ──
    const orgRow = await psql.query(iamUrl, RESET_GUARD_SQL.orgRow(org.orgId));
    const orgName = orgRow[0]?.[0];
    if (orgRow.length === 0 || orgName !== org.displayName) {
      this.error(
        `IDENTITY ASSERTION FAILED — iam groups row ${org.orgId} ` +
          (orgRow.length === 0 ? 'does not exist' : `is named '${orgName ?? ''}'`) +
          `, expected '${org.displayName}'. This database does not look like it holds the seeded ${org.slug} — refusing to touch anything.`,
      );
    }
    // iam.users has a unique `username` (the seeded admin HANDLE = the catalog
    // slug, e.g. 'empty') and NO email column — emails are PII in iam_pii. So the
    // in-iam identity check compares username against the slug, not the email.
    const adminRow = await psql.query(iamUrl, RESET_GUARD_SQL.adminUser(org.adminUserId));
    const adminLogin = adminRow[0]?.[0];
    if (adminRow.length === 0 || adminLogin !== org.adminSlug) {
      this.error(
        `IDENTITY ASSERTION FAILED — iam users row ${org.adminUserId} ` +
          (adminRow.length === 0 ? 'does not exist' : `has username '${adminLogin ?? ''}'`) +
          `, expected '${org.adminSlug}' (the seeded admin handle for ${org.adminEmail}). ` +
          `This database does not look like it holds the seeded ${org.slug} — refusing to touch anything.`,
      );
    }

    // ── plan + pre-delete counts (the enumeration; also the before-half of post-verify) ──
    const plan = buildResetPlan(ids);
    const reports: StoreReport[] = [];
    for (const store of plan) {
      const url = urls.get(store.store);
      const report: StoreReport = { store: store.store, service: store.service, connected: url !== undefined, tables: [] };
      for (const t of store.tables) {
        if (url === undefined) {
          report.tables.push({ table: t.table, projection: t.projection, before: null, after: null, skipped: 'no connection (--url)' });
          continue;
        }
        if (t.countSql === null) {
          report.tables.push({ table: t.table, projection: t.projection, before: null, after: null, skipped: t.skipped ?? 'skipped' });
          continue;
        }
        const rows = await psql.query(url, t.countSql);
        report.tables.push({ table: t.table, projection: t.projection, before: Number(rows[0]?.[0] ?? 0), after: null });
      }
      reports.push(report);
    }

    const totalBefore = reports.reduce((sum, s) => sum + s.tables.reduce((n, t) => n + (t.before ?? 0), 0), 0);
    const connectedStores = plan.filter((s) => urls.has(s.store));
    const skippedStores = plan.filter((s) => !urls.has(s.store));

    const enumeration = this.enumerationLines(org.displayName, org.slug, org.orgId, org.adminEmail, env.name, ids, reports);

    if (dry) {
      this.log(`${bold('▶ env org reset DRY RUN')} ${dim('— nothing will be changed:')}`);
      for (const line of enumeration) this.log(line);
      for (const s of skippedStores) {
        this.log(dim(`    note: store '${s.store}' has no --url — a real run SKIPS it (its org rows survive).`));
      }
      this.log(
        `${green('✓ reset dry run complete')} — ${bold(String(totalBefore))} row(s) would be deleted across ${bold(String(connectedStores.length))} store(s); ${dim('no changes made.')}`,
      );
      return;
    }

    if (!flags.yes) {
      // Enumeration + ONE prompt, even under --output-json/--porcelain — a
      // destructive command never proceeds silently; agents pass --yes.
      this.log(`${bold('▶ env org reset')} — ${bold(cyan(org.displayName))} ${dim(`(${org.slug})`)}:`);
      for (const line of enumeration) this.log(line);
      // No environment name in the prompt: --env is an UNVERIFIED label (it
      // only feeds display + the Lambda region) — the --url tunnels decide
      // what is actually deleted, and fixture-org UUIDs are identical across
      // environments, so an env claim here could assert the wrong thing.
      const ok = await this.getConfirm().prompt(
        `\n  This DELETES ${totalBefore} row(s) across ${connectedStores.length} store(s) for ${org.displayName} ` +
          `in whatever databases the --url connections point at, back to the seeded skeleton (org row + admin kept). Continue? [y/N] `,
      );
      if (!ok) {
        // Declined prompt = abort, not refusal — exit 0, nothing changed.
        this.log(dim('reset aborted — nothing changed.'));
        return;
      }
    } else if (human) {
      this.log(`${bold('▶ env org reset')} — ${bold(cyan(org.displayName))} ${dim(`(${org.slug}, --yes)`)}:`);
      for (const line of enumeration) this.log(line);
    }

    // ── best-effort snapshots (before ANY delete) ──
    const snapshots: SnapshotReport[] = [];
    if (flags.snapshot) {
      const overrides = new Map<string, string>();
      for (const entry of flags['snapshot-service'] ?? []) {
        const eq = entry.indexOf('=');
        if (eq === -1) this.error(`bad --snapshot-service '${entry}' — expected <store>=<serviceName>`);
        overrides.set(entry.slice(0, eq), entry.slice(eq + 1));
      }
      const aws = this.getEnvAws();
      for (const store of plan) {
        if (!urls.has(store.store) || store.transactionSql === null) continue; // nothing will die there
        const service = overrides.get(store.store) ?? store.dbService;
        if (service === undefined) {
          this.warn(
            `⚠ snapshot: no db-host registry name known for store '${store.store}' — ` +
              `pass --snapshot-service ${store.store}=<serviceName>; proceeding WITHOUT a restore point for it.`,
          );
          snapshots.push({ store: store.store, ok: false, skipped: 'no registry name known' });
          continue;
        }
        // Invoke inside try (unreachable ⇒ warn+proceed); judge the BODY outside
        // it so the not-in-registry abort is never swallowed as "unreachable".
        // Success is a FLAT body { ok, name, profile, …engine-specific } (orchestrator
        // API.md §snapshot) — there is no nested `snapshot` object; the restore point
        // is identified by (name/serviceName, profile).
        let body: { ok?: boolean; error?: string; name?: string; profile?: string } | null | undefined;
        try {
          body = (await aws.lambdaInvoke({
            functionName: ORCHESTRATOR_LAMBDA,
            payload: { action: 'snapshot', serviceName: service, profile: SNAPSHOT_PROFILE },
            profile: flags.profile,
            region: env.awsRegion,
          })) as typeof body;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.warn(`⚠ snapshot for '${store.store}' (${service}) skipped — orchestrator unreachable (${msg}); proceeding best-effort.`);
          snapshots.push({ store: store.store, service, ok: false, error: msg });
          continue;
        }
        if (body?.ok === true) {
          const profile = body.profile ?? SNAPSHOT_PROFILE;
          snapshots.push({ store: store.store, service, ok: true, name: body.name ?? service, profile });
          if (human) this.log(`  ${green('✓ snapshot')} ${cyan(store.store)} ${dim(`(${body.name ?? service})`)} → profile ${dim(`'${profile}'`)}`);
          continue;
        }
        const errMsg = body?.error ?? 'unknown orchestrator error';
        if (errMsg.includes('not in registry')) {
          // The control plane does not know this DB — the TARGET is wrong,
          // not just the snapshot. Abort the whole reset (nothing deleted).
          this.error(
            `snapshot: db '${service}' is not in the db-host registry (${errMsg}) — the target looks wrong; aborting the reset, nothing deleted.`,
          );
        }
        this.warn(`⚠ snapshot for '${store.store}' (${service}) FAILED — ${errMsg}; proceeding best-effort without a restore point.`);
        snapshots.push({ store: store.store, service, ok: false, error: errMsg });
      }
    }

    // ── execute: one transaction per store, leaf stores first, iam last ──
    const executable = connectedStores.filter((s) => s.transactionSql !== null);
    let step = 0;
    for (const store of plan) {
      const url = urls.get(store.store);
      if (url === undefined) {
        this.warn(`⚠ store '${store.store}' SKIPPED — no --url; its org-linked rows SURVIVE this reset.`);
        continue;
      }
      if (store.transactionSql === null) continue; // every table skipped (empty id-sets)
      step++;
      if (human) this.log(`${bold(`▶ ${step}/${executable.length}`)} ${cyan(store.store)} ${dim(`— ${store.statements.length} table(s), one transaction`)}`);
      await psql.query(url, store.transactionSql);
      if (human) this.log(`  ${green('✓')} ${cyan(store.store)} ${dim('reset')}`);
    }

    // ── post-verify: recount every table; leftovers are LOUD ──
    let leftoverRows = 0;
    for (const [i, store] of plan.entries()) {
      const url = urls.get(store.store);
      if (url === undefined) continue;
      for (const [j, t] of store.tables.entries()) {
        if (t.countSql === null) continue;
        const row = reports[i]?.tables[j];
        if (t.verify === 'indirect') {
          // The predicate subqueries rows deleted in the same transaction — a
          // recount is structurally 0 whether or not the delete worked. Report
          // the gap instead of a self-blinded number.
          if (row !== undefined) row.verify = 'indirect';
          if (human) this.log(dim(`  ○ ${store.store}.${t.table}: verify indirect — the delete predicate self-blinds post-delete; no recount.`));
          continue;
        }
        const rows = await psql.query(url, t.countSql);
        const after = Number(rows[0]?.[0] ?? 0);
        if (row !== undefined) row.after = after;
        if (after > 0) {
          leftoverRows += after;
          this.warn(`⚠ ${store.store}.${t.table}: ${after} row(s) REMAIN after reset — investigate before trusting this org.`);
        }
      }
    }

    // ── skeleton check: the seeded anchors must still be present and intact ──
    const orgAfter = await psql.query(iamUrl, RESET_GUARD_SQL.orgRow(org.orgId));
    const adminAfter = await psql.query(iamUrl, RESET_GUARD_SQL.adminUser(org.adminUserId));
    const membAfter = await psql.query(iamUrl, RESET_GUARD_SQL.adminMembership(org.adminMembershipId));
    const skeletonIntact =
      orgAfter[0]?.[0] === org.displayName && adminAfter[0]?.[0] === org.adminSlug && membAfter.length === 1;

    const deleted = totalBefore - leftoverRows;
    this.emit(
      flags,
      {
        org: { slug: org.slug, orgId: org.orgId, adminEmail: org.adminEmail },
        env: env.name,
        idSets: ids,
        snapshots,
        stores: reports,
        skeletonIntact,
        leftoverRows,
        deletedRows: deleted,
      },
      `${skeletonIntact ? green('✓') : red('✗')} ${bold(cyan(org.displayName))} reset — ${bold(String(deleted))} row(s) deleted across ${bold(String(step))} store(s)` +
        (skippedStores.length > 0 ? dim(`; ${skippedStores.length} store(s) skipped (no --url)`) : '') +
        (leftoverRows > 0 ? yellow(`; ⚠ ${leftoverRows} leftover row(s)`) : '') +
        `; skeleton ${skeletonIntact ? green('intact') : red('BROKEN')}.`,
    );
    if (!skeletonIntact) {
      this.error(
        `SKELETON CHECK FAILED — the seeded org row / admin user / admin membership did not all survive. ` +
          `Restore from the '${SNAPSHOT_PROFILE}' snapshot or re-run the seed before using ${org.slug}.`,
      );
    }
  }

  /** The destruction enumeration — identical for --dry-run, the confirm header, and --yes. */
  private enumerationLines(
    displayName: string,
    slug: string,
    orgId: string,
    adminEmail: string,
    envName: string,
    ids: ResetIdSets,
    reports: StoreReport[],
  ): string[] {
    const n = (v: number): string => (v > 0 ? bold(String(v)) : dim('0'));
    const lines: string[] = [
      `    ${dim('org:')}     ${bold(cyan(displayName))} ${dim(`(${slug}) ${orgId}`)}`,
      `    ${dim('env:')}     ${dim(`--env ${envName} (flag label only, UNVERIFIED — the --url connections decide what is deleted)`)}`,
      `    ${dim('kept:')}    ${dim(`org group row, admin ${adminEmail}, admin membership, ${ids.seededPersonaIds.length} seeded persona(s)`)}`,
      `    ${dim('id-sets:')} ${dim('groups=')}${n(ids.groupIds.length)} ${dim('users=')}${n(ids.userIds.length)} ${dim('deletable-users=')}${n(ids.userDelIds.length)} ` +
        `${dim('programs=')}${n(ids.programIds.length)} ${dim('periods=')}${n(ids.periodIds.length)} ${dim('cohorts=')}${n(ids.cohortIds.length)} ` +
        `${dim('pods=')}${n(ids.podIds.length)} ${dim('slots=')}${n(ids.slotIds.length)} ${dim('schedules=')}${n(ids.scheduleIds.length)} ${dim('sessions=')}${n(ids.sessionIds.length)}`,
    ];
    for (const s of reports) {
      lines.push(`    ${bold(cyan(s.store))} ${dim(`(${s.service})`)}${s.connected ? '' : dim(' — SKIPPED, no --url (rows survive)')}`);
      for (const t of s.tables) {
        const mark = t.projection ? dim(' [projection]') : '';
        if (t.before === null) lines.push(`      ${t.table}${mark}: ${dim(`— (${t.skipped ?? 'skipped'})`)}`);
        else lines.push(`      ${t.table}${mark}: ${t.before > 0 ? bold(String(t.before)) : dim('0')} ${dim('row(s) will be DELETED')}`);
      }
    }
    return lines;
  }
}
