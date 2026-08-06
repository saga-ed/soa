/**
 * `saga-stack stack hydrate` — replace a LOCAL slot's Postgres with the daily
 * prod MIRROR, so a developer gets real prod-shaped data across every store with
 * no per-store sync code.
 *
 * ── WHAT IT ACTUALLY DOES ──────────────────────────────────────────────────
 *   1. resolve the mirror at RUN TIME (SSM `/mirror/current/postgres-rds/*` +
 *      the Secrets Manager master secret),
 *   2. open ONE SSM port-forward through the dev jump host — the child process
 *      IS the tunnel, and it is torn down in a `finally` on every path,
 *   3. per database: stream `pg_dump | pg_restore` into a STAGING database, do
 *      the surgery there (view swap, re-own, grant), VERIFY it there, and only
 *      then swap it in by rename.
 *
 * Every argv and every SQL statement comes from the PURE planner in
 * `core/mirror/plan.ts`; this file is flags, guards, progress and reporting.
 *
 * ── DRY RUN BY DEFAULT (a deliberate divergence from `stack wipe`) ──────────
 * `stack wipe` is prompt-by-default. Hydrate is PREVIEW-by-default: it
 * overwrites entire databases from a remote source, and the thing a reader most
 * needs before running it is the mapping — which mirror database lands on which
 * local one. So a bare invocation prints the full replacement plan and exits 0
 * having touched nothing (and having made no AWS call at all). `--execute`
 * performs it; `--execute --yes` skips the destructive prompt for agents/CI.
 *
 * CLAIM WRINKLE: BaseCommand's central claim hook is suppressed by a flag named
 * EXACTLY `dry-run`, and hydrate does not have one. `claimsSlot()` therefore
 * gates on an `--execute` latch captured from the raw argv in `parse` (the
 * `stack wipe --slot all` precedent) — the invariant being preserved is "a
 * preview run never mutates `claim.json`", not the flag's spelling.
 *
 * ── GUARDS (each names the guard, the override, and the alternative) ────────
 *   - slot 0 / a bare `--slot` is REFUSED: slot 0 is the shared baseline and
 *     holds live work. An explicit `--slot 1..9` or `--set <name>` is required.
 *   - NON-LOCAL TARGET: the resolved container, host and port must be exactly
 *     the slot's own (`localTargetRefusal`) — a repointed
 *     `$SAGA_MESH_POSTGRES_CONTAINER` is refused, not obeyed. There is no flag
 *     that lets hydrate write anywhere but a local synthetic slot.
 *   - the slot's postgres container must be RUNNING.
 *   - AWS account preflight: the mirror lives in the DEV account.
 *   - live-claim refusal (another driver is running this slot); `--yes` overrides.
 *     Captured BEFORE the central claim hook overwrites `claim.json`.
 *   - a declined prompt is an ABORT — exit 0, nothing changed. The structural
 *     refusals above are `this.error` — exit 2.
 *
 * ── WHAT HYDRATE DOES NOT DO ───────────────────────────────────────────────
 * It does NOT make Coach reporting light up. Prod itself has
 * `group_track_map = 0` and `persona_assignment = 0`, so no restore of prod can
 * produce that routing; it is a separate concern. It also cannot fill Connect
 * (mongo — the mirror is Postgres-only) or insights (no mirror counterpart);
 * both are reported explicitly rather than silently skipped.
 *
 *   ss stack hydrate --slot 2                          # preview (default) — changes nothing
 *   ss stack hydrate --slot 2 --execute                # prompt, then hydrate the default DB set
 *   ss stack hydrate --slot 2 --db coach_api --execute --yes
 *   ss stack hydrate --slot 2 --source scrubbed --execute --yes
 *   ss stack hydrate --set my-set --execute --yes --keep-previous
 */

import { Flags } from '@oclif/core';
import type { Interfaces } from '@oclif/core';
import { BaseCommand } from '../../base-command.js';
import { bold, cyan, dim, green, yellow } from '../../color.js';
import { deriveInstance } from '../../core/derive-instance.js';
import { accountMismatchError, resolveEnv } from '../../core/env/index.js';
import {
  CONFIRMED_REAL_TABLES,
  DEFAULT_CLIENT_IMAGE,
  DEFAULT_LOCAL_PORT,
  MIRROR_ADMIN_USER,
  NO_MIRROR_SOURCE,
  localTargetRefusal,
  localTarget,
  mirrorDiscoveryArgv,
  planHydrate,
  realTableQuerySql,
  resolveSelection,
} from '../../core/mirror/index.js';
import type { HydrateDbPlan, HydrateStep, MirrorDbDef, RealTableInfo, SourceMode } from '../../core/mirror/index.js';
import {
  parseRealTableRows,
  pgRestoreFailed,
  postgresContainer,
  relativeAge,
  resolveJumpHost,
  resolveCallerAccount,
} from '../../runtime/index.js';
import type { ClaimReadResult, HydrateIO } from '../../runtime/index.js';

/** SSM parameter NAMES (never values) carrying the daily mirror's coordinates. */
const MIRROR_SSM = {
  endpoint: '/mirror/current/postgres-rds/endpoint',
  port: '/mirror/current/postgres-rds/port',
  masterSecretArn: '/mirror/current/postgres-rds/master-secret-arn',
} as const;

/** The environment whose account + jump host reach the mirror (it lives in dev). */
const MIRROR_ENV = 'dev';

/** Per-database outcome, the unit of both the report and the `--output-json` shape. */
interface DbOutcome {
  mirror: string;
  local: string;
  ownerRole: string;
  scrubbed: boolean;
  staging: string;
  previous: string | null;
  renamed: number;
  copied: number;
  steps: number;
  ok: boolean;
  error?: string;
  seconds: number;
}

export default class StackHydrate extends BaseCommand {
  static description =
    "Replace a local slot's Postgres databases with the daily prod mirror (SSM tunnel → staging database → verify → rename swap). " +
    'PREVIEW BY DEFAULT: a bare run prints exactly what would be replaced and touches nothing; --execute performs it. ' +
    'Requires an explicit --slot 1..9 or --set; slot 0 is refused.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --slot 2',
    '<%= config.bin %> <%= command.id %> --slot 2 --execute',
    '<%= config.bin %> <%= command.id %> --slot 2 --db coach_api,iam_db --execute --yes',
    '<%= config.bin %> <%= command.id %> --slot 2 --source scrubbed --execute --yes',
    '<%= config.bin %> <%= command.id %> --set my-set --execute --yes --keep-previous',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    source: Flags.string({
      options: ['real', 'scrubbed'],
      default: 'real',
      description:
        "which copy of the two SCRUBBED databases (iam_db, iam_pii_db) to land. 'real' (DEFAULT) lands the " +
        'unscrambled tables — prod is PRE-RELEASE and every user in it is a Saga employee, so there is no real ' +
        'end-user PII today, and the scramble makes a poor reporting fixture (a known district cannot be found by ' +
        "display_name or source_id at all). 'scrubbed' lands the scrambled view materialised into a real writable " +
        'table instead. NOTE: only the rostering project is scrubbed upstream — every OTHER database is raw prod ' +
        'data in BOTH modes, so --source scrubbed does NOT make a hydrate free of prod data. This default FLIPS at ' +
        'public release, when prod holds real end-user data.',
    }),
    db: Flags.string({
      multiple: true,
      description:
        "databases to hydrate: mirror or local names (comma- or flag-repeatable), plus 'default' and 'all'. " +
        'DEFAULT (when omitted) is every mapping with a verified name pair and a slot-provisioned local home: ' +
        'scheduling, sessions, iam_local, programs, authz_local, coach_api, authz_sync_local, iam_pii_local, ' +
        'sis_db, ads_adm_local, ledger_local, content. Opt-in extras: openfga (its local schema is sidecar-owned), ' +
        'transcripts_local (mapping unverified + playback-only), chat_local (playback-only).',
    }),
    execute: Flags.boolean({
      default: false,
      description:
        'actually perform the replacement. Without it this command is a PREVIEW: it prints the full plan, makes no ' +
        'AWS call, opens no tunnel, writes no claim, and exits 0.',
    }),
    yes: Flags.boolean({
      default: false,
      description:
        'non-interactive: skip the destructive-action prompt AND override the live-claim guard (CI / agents). ' +
        'Only meaningful with --execute.',
    }),
    'local-port': Flags.integer({
      default: DEFAULT_LOCAL_PORT,
      description:
        "local end of the SSM tunnel to the mirror. Deliberately NOT `env connect`'s 15432 so an open `ss env connect` and a hydrate cannot collide.",
    }),
    profile: Flags.string({
      description: 'AWS profile for the mirror account (defaults to the ambient credential chain; dev_admin is the usual one).',
    }),
    'jump-host': Flags.string({
      description: 'override the EC2 Name tag of the SSM jump host (default: the dev environment\'s).',
    }),
    'keep-previous': Flags.boolean({
      default: false,
      description:
        'keep each displaced database as <db>__pre_hydrate_<stamp> instead of dropping it — a one-command rollback (rename it back).',
    }),
    'client-image': Flags.string({
      default: DEFAULT_CLIENT_IMAGE,
      description:
        'ephemeral postgres client image for the dump/restore pipelines. Must be >= the mirror server version (PG 18.3) and must carry bash (the pipelines run under `bash -o pipefail`).',
    }),
  };

  /** Hydrate targets an isolated slot 1..9; slot 0 is refused in run(). */
  protected slotAware(): boolean {
    return true;
  }

  /** A set is repo paths + a slot >= 1 — exactly hydrate's target. */
  protected setAware(): boolean {
    return true;
  }

  /**
   * An executing hydrate DRIVES the slot (a failed one usefully records who
   * attempted it); a preview must claim nothing. See the CLAIM WRINKLE note in
   * the header for why this is gated on a raw-argv latch rather than `--dry-run`.
   */
  protected claimsSlot(): boolean {
    return this.executeMode;
  }

  /** `--execute` detected from the raw argv in `parse`, before flag parsing. */
  private executeMode = false;

  /** Prior drivers' claims, captured BEFORE the central hook overwrites claim.json. */
  private priorClaims = new Map<string, ClaimReadResult>();

  /**
   * Two things must happen before `super.parse` writes this invocation's claim:
   * the `--execute` latch that `claimsSlot()` reads, and the capture of the
   * PRIOR driver's claim that the live-claim guard needs (a naive read in run()
   * would see hydrate's OWN claim and the guard would silently never fire —
   * `stack wipe`'s wrinkle).
   */
  protected async parse<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    F extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    B extends { [flag: string]: any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    A extends { [arg: string]: any },
  >(
    options?: Interfaces.Input<F, B, A>,
    argv?: string[],
  ): Promise<Interfaces.ParserOutput<F, B, A>> {
    const raw = argv ?? this.argv;
    this.executeMode = raw.includes('--execute');
    this.capturePriorClaims(raw);
    return super.parse<F, B, A>(options, argv);
  }

  /** Read (never write) the current claim of every candidate state dir. */
  private capturePriorClaims(rawArgv: readonly string[]): void {
    const reader = this.getClaimReader();
    const dirs = new Set<string>();
    // Slot 0 is refused before anything is touched, so only 1..9 matter.
    for (let slot = 1; slot <= 9; slot++) dirs.add(deriveInstance({ slot }).stateDir);
    for (let i = 0; i < rawArgv.length; i++) {
      const token = rawArgv[i];
      if (token === undefined) continue;
      const next = rawArgv[i + 1];
      if (token === '--state-dir' && next !== undefined) dirs.add(next);
      else if (token.startsWith('--state-dir=')) dirs.add(token.slice('--state-dir='.length));
    }
    for (const dir of dirs) {
      const result = reader.read(dir);
      if (result !== null) this.priorClaims.set(dir, result);
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(StackHydrate);
    const execute = flags.execute;
    const human = !flags['output-json'] && !flags.porcelain;
    const slot = flags.slot;

    // ── GUARD: slot 0 / bare invocation, and any non-local write target ──
    // The AMBIENT override is read BEFORE `applyInstanceEnv` deterministically
    // overwrites it: at slot > 0 the profile would silently repair a repointed
    // `$SAGA_MESH_POSTGRES_CONTAINER`, and at slot 0 it would leave it in force.
    // Neither is right for a command that overwrites whole databases — an
    // operator who has repointed the container gets a refusal, not a guess.
    const ambientContainer = process.env.SAGA_MESH_POSTGRES_CONTAINER;
    const profile = deriveInstance({ slot });
    this.applyInstanceEnv(profile);
    const container = postgresContainer();
    const localPort = 5432 + profile.meshOffset;
    const refusal = localTargetRefusal({
      slot,
      container: ambientContainer ?? container,
      host: '127.0.0.1',
      port: localPort,
    });
    if (refusal !== null) this.error(refusal);

    // ── selection ──
    let selection: MirrorDbDef[];
    try {
      selection = resolveSelection((flags.db ?? []).flatMap((token) => token.split(',')));
    } catch (err) {
      return this.error((err as Error).message);
    }
    if (selection.length === 0) this.error('--db selected nothing — drop the flag for the default set, or pass `all`.');
    const mode = flags.source as SourceMode;
    // `--source scrubbed` is NOT safe yet and refuses rather than aborting
    // confusingly mid-restore. Two confirmed defects, both in this path only:
    // emptying the `_real` tables breaks incoming FKs from tables that DO carry
    // data, and the per-table COPY steps are emitted alphabetically rather than
    // in FK-topological order. Both abort inside the staging database, so the
    // live copy is never at risk — but there is no reason to let an operator
    // discover that the hard way. `real` is the default and the mode that
    // matters until public release, which is when this must be fixed.
    if (mode === 'scrubbed') {
      this.error(
        '--source scrubbed is not usable yet: emptied _real tables break incoming foreign keys, and the ' +
          'materialising COPY steps are not ordered FK-topologically, so the restore aborts. Use --source real ' +
          '(the default) — prod is pre-release and carries no end-user PII. This must be fixed before public release.'
      );
    }

    // ── GUARD: live prior claim (another driver is running this slot) ──
    const stateDir = flags['state-dir'] ?? profile.stateDir;
    const prior = this.priorClaims.get(stateDir);
    const foreignLive = prior !== undefined && prior.live && prior.claim.pid !== process.pid;
    if (foreignLive && execute && !flags.yes) {
      this.error(
        `slot ${slot}: claimed by ${prior.claim.actor} ${relativeAge(prior.claim.at)} ago and still running ` +
          `(pid ${prior.claim.pid} — \`${prior.claim.command}\`). ` +
          'Refusing to hydrate under a live driver; pass --yes to override.',
      );
    }

    // ── the enumeration: identical for the preview, the confirm header and --yes ──
    // Built with the CONFIRMED `_real` set; an executing run re-enumerates it from
    // the live mirror before planning for real (only rostering is scrubbed, and
    // that project's scrubbed table set moves with its schema).
    const previewReal = previewRealTables(selection);
    const preview = planHydrate({
      slot,
      mode,
      selection,
      pgContainer: container,
      localPort,
      mirrorLocalPort: flags['local-port'],
      localExists: Object.fromEntries(selection.map((d) => [localTarget(d).name, true])),
      realTables: previewReal,
      stamp: '<stamp>',
      keepPrevious: flags['keep-previous'],
      clientImage: flags['client-image'],
    });
    const planLines = this.planLines(preview, mode, flags['local-port']);

    if (!execute) {
      this.log(`${bold('▶ stack hydrate PREVIEW')} — slot ${bold(String(slot))} (nothing will be changed):`);
      for (const line of planLines) this.log(line);
      if (foreignLive) {
        this.log(
          `    note: slot is live-claimed by ${prior.claim.actor} (${relativeAge(prior.claim.at)} ago) — ` +
            'an --execute run will refuse without --yes.',
        );
      }
      this.log(dim('    (the _real table set above is the CONFIRMED one; an --execute run enumerates it live from the mirror)'));
      this.log(`${green('✓')} preview complete — no AWS call, no tunnel, no changes.`);
      return;
    }

    if (!flags.yes) {
      // The enumeration + one prompt run even under --output-json/--porcelain — a
      // destructive command never proceeds silently; agents pass --yes for clean output.
      this.log(`${bold('▶ stack hydrate')} — slot ${bold(String(slot))}:`);
      for (const line of planLines) this.log(line);
      const ok = await this.getConfirm().prompt(
        `\n  This REPLACES ${selection.length} database(s) on slot ${slot} with prod-mirror data` +
          `${flags['keep-previous'] ? ' (previous copies kept)' : ' (previous copies dropped)'}. Continue? [y/N] `,
      );
      if (!ok) {
        this.log('hydrate aborted — nothing changed.');
        return;
      }
    } else if (human) {
      this.log(`${bold('▶ stack hydrate')} — slot ${bold(String(slot))} (--yes):`);
      for (const line of planLines) this.log(line);
    }

    const io = this.getHydrateIO();
    await io.assertPgRunning(container);

    // ── AWS: account preflight, then RUN-TIME resolution of the daily mirror ──
    const env = resolveEnv(MIRROR_ENV);
    if (env === undefined) this.error(`internal: no '${MIRROR_ENV}' environment in the registry`);
    const awsOpts = { profile: flags.profile, region: env.awsRegion };
    const aws = this.getEnvAws();
    const mismatch = accountMismatchError(await resolveCallerAccount(aws, awsOpts), [env.awsAccountId], 'the prod mirror');
    if (mismatch !== null) this.error(mismatch);

    // The mirror instance is REPLACED daily by a 13:30 UTC CFN cron, so BOTH the
    // endpoint and the master password change every day. Everything below is read
    // fresh on every invocation and never memoized, written to the state dir, or
    // added to the env registry — the `resolveSharedEndpoint` stance.
    const endpoint = await this.fetchParam(MIRROR_SSM.endpoint, awsOpts);
    const remotePortRaw = await this.fetchParam(MIRROR_SSM.port, awsOpts);
    const remotePort = Number(remotePortRaw);
    if (!Number.isInteger(remotePort) || remotePort <= 0) {
      this.error(`SSM ${MIRROR_SSM.port} is not a port number ('${remotePortRaw}')`);
    }
    const secretArn = await this.fetchParam(MIRROR_SSM.masterSecretArn, awsOpts);
    const { username, password } = await this.fetchMasterSecret(secretArn, awsOpts);

    // The x86 and arm shared-ECS fleets BOTH sit in the mirror SG's 5432 ingress,
    // and either may be the one that happens to be SSM-Online: measured 2026-08-06,
    // no `dev-shared-ecs-instance` was Online while two `dev-shared-arm-ecs-instance`
    // were. Resolving only the registry's tag would have failed for no good reason,
    // so fall back to the arm fleet before giving up. An explicit --jump-host still
    // wins outright and is never second-guessed.
    const explicitJump = flags['jump-host'];
    const tagsToTry = explicitJump !== undefined ? [explicitJump] : [env.jumpHostNameTag, `${env.jumpHostNameTag.replace(/-ecs-instance$/, '')}-arm-ecs-instance`];
    let jump: string | undefined;
    let nameTag = tagsToTry[0]!;
    for (const tag of tagsToTry) {
      jump = await resolveJumpHost(aws, tag, awsOpts);
      if (jump !== undefined) {
        nameTag = tag;
        break;
      }
    }
    if (jump === undefined) {
      this.error(`no running+Online SSM jump host tagged Name=${tagsToTry.join(' or Name=')} — check tier/region/profile.`);
    }

    if (human) {
      this.log(`  ${dim('mirror:')}   ${endpoint}:${remotePort} ${dim(`(SSM ${MIRROR_SSM.endpoint}, resolved now)`)}`);
      this.log(`  ${dim('route:')}    jump host ${jump} → 127.0.0.1:${flags['local-port']}`);
    }

    // ── the tunnel: the child process IS the tunnel, and it dies in the finally ──
    const handle = aws.portForward({
      target: jump,
      host: endpoint,
      remotePort,
      localPort: flags['local-port'],
      region: env.awsRegion,
      profile: flags.profile,
    });
    // Registering a SIGINT listener REPLACES node's default terminate behaviour,
    // so a bare `handle.stop()` would make Ctrl-C close the tunnel while the
    // destructive loop kept running against a dead connection — the operator
    // cannot abort a hydrate. Mark aborting (checked between databases), stop
    // the tunnel, then re-raise so the process actually dies.
    let aborted: NodeJS.Signals | null = null;
    const stopTunnel = (sig: NodeJS.Signals) => (): void => {
      aborted = sig;
      handle.stop();
      process.off(sig, stopTunnel(sig));
      // Give the tunnel a beat to die, then restore default disposition.
      setTimeout(() => {
        process.kill(process.pid, sig);
      }, 50).unref?.();
    };
    const onInt = stopTunnel('SIGINT');
    const onTerm = stopTunnel('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    void aborted; // recorded for the finally-block's log line below

    let outcomes: DbOutcome[] = [];
    try {
      await handle.ready;
      if (human) this.log(`${green('✓ tunnel up')} — 127.0.0.1:${flags['local-port']} → ${endpoint}:${remotePort}`);
      outcomes = await this.hydrateAll({
        io,
        flags,
        slot,
        mode,
        selection,
        container,
        localPort,
        secret: password,
        mirrorUser: username,
        human,
      });
    } finally {
      // A throw mid-restore without this leaks a detached session-manager-plugin
      // that keeps holding the local port — the soa#370 failure mode.
      handle.stop();
      await handle.exited.catch(() => undefined);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (human) this.log(dim('tunnel closed.'));
    }

    // ── the report: emitted IN FULL before any non-zero exit ──
    const failed = outcomes.filter((o) => !o.ok);
    const lines = outcomes.map(
      (o) =>
        `  ${o.ok ? green('✓') : yellow('✗')} ${o.mirror} → ${o.local}` +
        `  ${dim(`${o.seconds}s, ${o.steps} steps`)}` +
        (o.renamed > 0 ? dim(`, ${o.renamed} table(s) materialised`) : '') +
        (o.previous !== null ? dim(`, previous kept as ${o.previous}`) : '') +
        (o.ok ? '' : `\n      ${o.error ?? 'failed'}`),
    );
    for (const note of NO_MIRROR_SOURCE) lines.push(dim(`  · ${note.local}: not hydrated — ${note.why}`));
    lines.push(
      dim(
        '  · Coach reporting stays dark: prod itself has group_track_map = 0 and persona_assignment = 0, ' +
          'so no hydrate can populate that routing.',
      ),
    );

    // `emit`'s porcelain branch stringifies values directly, so a nested object
    // array would render as `[object Object]`. The scalar summary is what
    // porcelain gets; `--output-json` additionally carries the per-database detail.
    const summary = {
      slot,
      mode,
      dryRun: false,
      hydrated: outcomes.filter((o) => o.ok).map((o) => o.local).join(','),
      failed: failed.map((o) => o.local).join(','),
    };
    this.emit(
      flags,
      flags.porcelain ? summary : { ...summary, databases: outcomes },
      [
        `${bold('▶ stack hydrate')} — slot ${slot}, source ${cyan(mode)}: ` +
          `${outcomes.length - failed.length}/${outcomes.length} database(s) hydrated`,
        ...lines,
      ],
    );

    if (failed.length > 0) this.exit(1);
  }

  /**
   * Run every selected database, one at a time. A per-database failure is
   * CONTAINED — its live database was never touched (all the work happened in a
   * staging database), so the sweep continues and the whole report is emitted
   * before the non-zero exit.
   */
  private async hydrateAll(ctx: {
    io: HydrateIO;
    flags: { [k: string]: unknown };
    slot: number;
    mode: SourceMode;
    selection: MirrorDbDef[];
    container: string;
    localPort: number;
    secret: string;
    mirrorUser: string;
    human: boolean;
  }): Promise<DbOutcome[]> {
    const flags = ctx.flags as {
      'local-port': number;
      'client-image': string;
      'keep-previous': boolean;
    };

    // ── discovery, through the tunnel: the scrub's `_real` tables + column order ──
    const realTables: Record<string, RealTableInfo[]> = {};
    for (const def of ctx.selection.filter((d) => d.scrubbed)) {
      const argv = mirrorDiscoveryArgv({
        image: flags['client-image'],
        mirrorPort: flags['local-port'],
        user: ctx.mirrorUser,
        database: def.mirror,
        sql: realTableQuerySql(),
      });
      const res = await ctx.io.exec(argv, { secret: ctx.secret });
      if (res.code !== 0) {
        throw new Error(`could not enumerate ${def.mirror}'s scrubbed tables (exit=${res.code}): ${res.stderr.trim().slice(-400)}`);
      }
      const discovered = parseRealTableRows(res.stdout);
      // A SOFT-empty enumeration — exit 0, zero rows — is the dangerous case, and
      // exit code alone cannot see it. `def.scrubbed` means we KNOW this database
      // carries the view swap, so zero `_real` tables means the query stopped
      // matching reality (the scrub moved off `public`, renamed the suffix, or
      // simply did not run today). Continuing would emit no view-swap steps AND
      // skip the no-views assertion that guards them, then promote a database
      // whose app-named relations are still read-only VIEWS — and drop the good
      // one. Refuse instead, naming the floor we expected.
      if (discovered.length === 0) {
        const expected = CONFIRMED_REAL_TABLES[def.mirror] ?? [];
        throw new Error(
          `enumerated ZERO _real tables in ${def.mirror}, but it is a scrubbed database — ` +
            `expected at least ${expected.length} (e.g. ${expected.slice(0, 3).join(', ')}). ` +
            `The daily scrub may not have run, or its naming changed. Refusing: hydrating now would ` +
            `land read-only scramble VIEWS under the app's table names and destroy the local copy. ` +
            `Verify the mirror was refreshed today, then re-run.`
        );
      }
      realTables[def.mirror] = discovered;
      if (ctx.human) {
        this.log(`  ${dim('scrub:')}    ${def.mirror} — ${discovered.length} _real table(s) enumerated live`);
      }
    }

    // ── which local databases exist (drives the swap's rename-away step) ──
    const probe = this.getPgProbe();
    const localExists: Record<string, boolean> = {};
    for (const def of ctx.selection) {
      const { name } = localTarget(def);
      localExists[name] = await probe.databaseExists(ctx.container, name);
    }

    const plan = planHydrate({
      slot: ctx.slot,
      mode: ctx.mode,
      selection: ctx.selection,
      pgContainer: ctx.container,
      localPort: ctx.localPort,
      mirrorLocalPort: flags['local-port'],
      mirrorUser: ctx.mirrorUser,
      localExists,
      realTables,
      stamp: stampNow(),
      keepPrevious: flags['keep-previous'],
      clientImage: flags['client-image'],
    });

    const outcomes: DbOutcome[] = [];
    let index = 0;
    for (const db of plan.dbs) {
      index += 1;
      const started = Date.now();
      // Per-database progress: this is SLOW (scheduling_api alone is 178MB), so
      // the header lands before the work, not after it.
      if (ctx.human) {
        this.log(
          `${bold(`▶ ${index}/${plan.dbs.length}`)} ${cyan(db.mirrorName)} → ${cyan(db.localName)} ` +
            dim(`(owner ${db.ownerRole}, ${db.steps.length} steps${db.scrubbed ? `, ${db.mode} source` : ''})`),
        );
      }
      let ok = true;
      let error: string | undefined;
      try {
        for (const step of db.steps) {
          if (ctx.human) this.log(`    ${dim('·')} ${step.label}`);
          await this.runStep(ctx.io, step, ctx.secret);
        }
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
        this.warn(`${db.localName}: ${error}`);
      }
      outcomes.push(outcomeFor(db, ok, error, Math.round((Date.now() - started) / 1000), flags['keep-previous']));
    }
    return outcomes;
  }

  /**
   * Run ONE planned step. The only judgment here is the exit-code classification,
   * and it is the thing most worth getting right: `pg_restore` exits non-zero on
   * benign warnings — and a `--no-owner --no-privileges` prod dump emits a pile
   * of them — so those steps are classified from stderr with the existing
   * `pgRestoreFailed`. Treating exit != 0 as failure would make every hydrate
   * look broken; inverting it would make a real failure look green, which is why
   * the planner also asserts the staging database is non-empty afterwards.
   */
  private async runStep(io: HydrateIO, step: HydrateStep, secret: string): Promise<void> {
    const attempts = (step.kind === 'sql' ? step.retries ?? 0 : 0) + 1;
    let last: { code: number | null; stdout: string; stderr: string } | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await io.exec(step.dockerArgv, step.needsSecret === true ? { secret } : {});
      last = res;
      const failed =
        step.kind === 'transfer' && step.classify === 'pg_restore'
          ? pgRestoreFailed(res.code, res.stderr)
          : res.code !== 0;
      if (!failed) {
        if (step.kind === 'sql' && step.expect !== undefined) {
          const actual = res.stdout.trim();
          if (actual !== step.expect) {
            throw new Error(
              (step.expectMessage ?? `${step.id}: expected '${step.expect}', got '%s'`).replace(
                '%s',
                actual === '' ? '(empty)' : actual,
              ),
            );
          }
        }
        return;
      }
      if (attempt < attempts) await this.getSleep()(500);
    }
    throw new Error(
      `${step.id} failed (exit=${last?.code ?? 'signal'}): ${(last?.stderr ?? '').trim().slice(-800) || '(no stderr)'}`,
    );
  }

  /** The replacement enumeration — identical for the preview, the confirm header, and --yes. */
  private planLines(plan: ReturnType<typeof planHydrate>, mode: SourceMode, tunnelPort: number): string[] {
    const lines = [
      `    slot:      ${plan.slot} — container ${plan.pgContainer}, postgres 127.0.0.1:${plan.localPort}`,
      `    source:    prod mirror via SSM tunnel 127.0.0.1:${tunnelPort} (resolved at run time, ${MIRROR_ADMIN_USER})`,
      `    mode:      --source ${mode}` +
        (mode === 'real'
          ? ' — unscrambled rostering tables (prod is pre-release; this flips at public release)'
          : ' — scrambled rostering views materialised into real writable tables'),
      `    previous:  ${plan.keepPrevious ? 'KEPT as <db>__pre_hydrate_<stamp>' : 'DROPPED after the swap (pass --keep-previous to keep them)'}`,
      '    replaces:',
    ];
    for (const db of plan.dbs) {
      lines.push(
        `      ${db.mirrorName.padEnd(18)} → ${db.localName.padEnd(18)} owner ${db.ownerRole}` +
          (db.scrubbed ? `  [scrubbed: ${db.renamedTables.length} table(s) ${db.copiedTables.length > 0 ? 'materialised from the view' : 'taken from *_real'}]` : ''),
      );
    }
    for (const note of NO_MIRROR_SOURCE) lines.push(`    skipped:   ${note.local} — ${note.why}`);
    return lines;
  }

  /** One plain SSM parameter value (mirror coordinates — nothing encrypted here). */
  private async fetchParam(name: string, opts: { profile?: string; region: string }): Promise<string> {
    const value = (await this.getEnvAws().json(
      ['ssm', 'get-parameter', '--name', name, '--query', 'Parameter.Value'],
      opts,
    )) as string | null;
    if (value === null || value === '') {
      this.error(`SSM parameter ${name} resolved to nothing — is the profile/region right for the mirror account?`);
    }
    return value;
  }

  /**
   * The RDS master secret: `{username, password}` JSON from Secrets Manager,
   * fetched fresh on every run (the daily CFN replace rotates it). The value is
   * returned in memory ONLY — never logged, never written to the state dir,
   * never placed in argv.
   */
  private async fetchMasterSecret(
    secretId: string,
    opts: { profile?: string; region: string },
  ): Promise<{ username: string; password: string }> {
    const raw = (await this.getEnvAws().json(
      ['secretsmanager', 'get-secret-value', '--secret-id', secretId, '--query', 'SecretString'],
      opts,
    )) as string | null;
    if (raw === null || raw === '') this.error(`mirror master secret ${secretId} resolved to nothing`);
    let parsed: { username?: unknown; password?: unknown };
    try {
      parsed = JSON.parse(raw) as { username?: unknown; password?: unknown };
    } catch {
      // Deliberately does NOT echo the value — an unparseable secret is still a secret.
      return this.error(`mirror master secret ${secretId} is not JSON (expected {"username":…,"password":…})`);
    }
    const username = typeof parsed.username === 'string' && parsed.username !== '' ? parsed.username : MIRROR_ADMIN_USER;
    if (typeof parsed.password !== 'string' || parsed.password === '') {
      this.error(`mirror master secret ${secretId} carries no password field`);
    }
    return { username, password: parsed.password };
  }
}

/** `20260806T133000Z` — the token in `<db>__pre_hydrate_<stamp>`. */
function stampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** The preview's `_real` sets: the CONFIRMED measurement, used only when nothing is executed. */
function previewRealTables(selection: readonly MirrorDbDef[]): Record<string, RealTableInfo[]> {
  const out: Record<string, RealTableInfo[]> = {};
  for (const def of selection) {
    if (!def.scrubbed) continue;
    out[def.mirror] = (CONFIRMED_REAL_TABLES[def.mirror] ?? []).map((table) => ({ table, columns: [] }));
  }
  return out;
}

function outcomeFor(
  db: HydrateDbPlan,
  ok: boolean,
  error: string | undefined,
  seconds: number,
  keepPrevious: boolean,
): DbOutcome {
  return {
    mirror: db.mirrorName,
    local: db.localName,
    ownerRole: db.ownerRole,
    scrubbed: db.scrubbed,
    staging: db.stagingName,
    previous: ok && keepPrevious && db.localExisted ? db.retiredName : null,
    renamed: db.renamedTables.length,
    copied: db.copiedTables.length,
    steps: db.steps.length,
    ok,
    error,
    seconds,
  };
}
