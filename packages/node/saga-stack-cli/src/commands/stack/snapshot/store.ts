/**
 * `saga-stack stack snapshot store` — native DB snapshot fast-path (plan §4.3,
 * §7.2 "M3"). Supersedes mesh-fixture-cli's `snapshot:store`.
 *
 * DUMPS every database the snapshot scope covers — all 9 postgres app DBs + the
 * connectv3 MONGO DB by default (mesh-fixture-cli only knew 6 pg DBs) — into
 * `~/.saga-mesh/snapshots/<fixture-id>/` and writes a zod-validated
 * `manifest.json` recording each DB's engine, owner role, captured `schemaRev`
 * (the `_prisma_migrations` head; null for db-push / mongo), and dump size.
 *
 * THIN: the pure `storePlan` (core/snapshot) decides WHICH DBs to dump; the
 * injectable `SnapshotIO` (runtime/snapshot — `this.getSnapshotIO()`) does the
 * `docker exec pg_dump/mongodump/psql`. Tests spy `getSnapshotIO` to capture the
 * calls with no real container, DB, or dump file.
 *
 *   node bin/dev.js stack snapshot store --fixture-id demo-small
 *   node bin/dev.js stack snapshot store --fixture-id full --profile full --with playback
 *   node bin/dev.js stack snapshot store --fixture-id iam --only iam-api
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { deriveInstance } from '../../../core/derive-instance.js';
import { BUNDLE_NAMES, combineRequested, effectiveWithAuthz, effectiveWithPlayback } from '../../../core/bundles.js';
import { computeClosure } from '../../../core/closure.js';
import { manifest } from '../../../core/manifest/index.js';
import type { DbId, ServiceId } from '../../../core/manifest/index.js';
import { storePlan, CURRENT_SNAPSHOT_SCHEMA_VERSION } from '../../../core/snapshot/index.js';
import type { SnapshotDbEntry, SnapshotManifest } from '../../../core/snapshot/index.js';
import {
  ensureSnapshotDir,
  fileSize,
  formatBytes,
  mongoContainer,
  postgresContainer,
  snapshotDir,
  writeManifest,
} from '../../../runtime/index.js';

export default class SnapshotStore extends BaseCommand {
  static description =
    'Dump all stack databases (9 pg app DBs + connectv3 mongo) into a named snapshot.';

  static examples = [
    '<%= config.bin %> <%= command.id %> --fixture-id demo-small',
    '<%= config.bin %> <%= command.id %> --fixture-id full --profile full --with playback',
    '<%= config.bin %> <%= command.id %> --fixture-id iam --only iam-api',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    'fixture-id': Flags.string({
      description: 'fixture identifier (= snapshot directory name)',
      required: true,
    }),
    profile: Flags.string({
      description: 'SEED_PROFILE stamped into the manifest (drives the restore profile guard)',
      default: 'roster',
    }),
    only: Flags.string({
      description:
        'scope the dump to the dependency closure of these services (comma-list). `--with` bundle services union into this closure.',
    }),
    with: Flags.string({
      multiple: true,
      options: [...BUNDLE_NAMES],
      description:
        "convenience bundle(s) whose DBs join the dump — sugar shared with `stack up`. Repeatable: --with coach --with playback. `--with playback` also dumps the optional playback DBs (transcripts, insights, chat = the old --with-playback). With `--only`, a bundle's services union into the scoped closure (e.g. `--only iam-api --with coach` adds coach_api); without `--only`, non-playback bundles are no-ops (their DBs are already in the default full dump).",
    }),
    force: Flags.boolean({
      description: 'overwrite an existing snapshot with the same fixture id',
      default: false,
    }),
  };

  /** M13-A: snapshot state is env-parameterized; the slot's env seam isolates it. */
  protected slotAware(): boolean {
    return true;
  }

  /** M13-A: `--set` targets the set's slot's containers + snapshot dir. */
  protected setAware(): boolean {
    return true;
  }

  /** Slot claims: the dump writes the slot's snapshot state — record the advisory claim on entry. */
  protected claimsSlot(): boolean {
    return true;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotStore);
    // M13-A: apply the slot env seam BEFORE any snapshot-store resolver runs —
    // snapshotsRoot()/postgresContainer()/… read $SAGA_MESH_* at call time.
    const instance = deriveInstance({ slot: flags.slot });
    this.applyInstanceEnv(instance);
    const fixtureId = flags['fixture-id'];

    // `--with playback` admits the optional playback DBs (== the old
    // --with-playback). With `--only`, the `--with` bundle services union into
    // the scoped closure; without it, the default full-dump path is used and
    // withPlayback layers the playback trio on top.
    //
    // M13-A: at slot > 0 the excluded literal-port services' DBs are never
    // provisioned in the slot's postgres — a bare full dump would pg_dump
    // nonexistent DBs and fail. Scope the DEFAULT set to the non-excluded
    // closure. The exclusion MUST apply POST-closure (like `up`/`reset`):
    // filtering the requested set first is defeated by closure edges pulling
    // an excluded service back in (a dependency edge from a non-excluded service
    // into an excluded one), and it applies AFTER the --with union so `--with playback --slot N`
    // degrades gracefully rather than dumping absent playback DBs.
    const withPlayback = effectiveWithPlayback(flags.with);
    const withAuthz = effectiveWithAuthz(flags.with);
    const excluded = new Set<ServiceId>(instance.excludedServices);
    let only: DbId[] | undefined;
    if (flags.only) {
      only = closureDatabases(
        combineRequested(flags.only, flags.with, (m) => this.error(m)),
        withPlayback,
        withAuthz,
        (m) => this.error(m),
      );
    } else if (instance.slot > 0) {
      const fullNonOptional = (Object.values(manifest.services) as { id: ServiceId; optional: boolean }[])
        .filter((s) => !s.optional)
        .map((s) => s.id);
      const bundleServices = combineRequested(undefined, flags.with, (m) => this.error(m));
      const requested = [...new Set<ServiceId>([...fullNonOptional, ...bundleServices])];
      const kept = computeClosure(manifest, requested, { withPlayback, withAuthz }).services.filter(
        (id) => !excluded.has(id),
      );
      only = [...new Set<DbId>(kept.flatMap((id) => manifest.services[id].databases))];
    }

    const plan = storePlan(manifest, {
      fixtureId,
      profile: flags.profile,
      only,
      withPlayback,
      withAuthz,
    });

    const io = this.getSnapshotIO();
    const pgC = postgresContainer();
    const mongoC = mongoContainer();

    // Fail fast (actionable) if the containers the dump targets are down.
    await io.assertPgRunning(pgC);
    if (plan.databases.some((d) => d.engine === 'mongo')) {
      await io.assertMongoRunning(mongoC);
    }

    const dir = snapshotDir(fixtureId);
    if (existsSync(dir) && !flags.force) {
      this.error(`snapshot '${fixtureId}' already exists at ${dir}. Use --force to overwrite.`);
    }
    ensureSnapshotDir(dir);

    const databases: SnapshotDbEntry[] = [];
    for (const action of plan.databases) {
      const outPath = join(dir, action.file);
      if (action.engine === 'mongo') {
        await io.mongoDump(mongoC, action.db, outPath);
      } else {
        await io.pgDump(action.db, pgC, action.ownerRole, outPath);
      }
      const schemaRev = action.captureSchemaRev ? await io.readSchemaRev(action.db, pgC) : null;
      databases.push({
        db: action.db,
        engine: action.engine,
        ownerRole: action.ownerRole,
        schemaRev,
        sizeBytes: fileSize(outPath),
        file: action.file,
      });
    }

    const snapshot: SnapshotManifest = {
      schemaVersion: CURRENT_SNAPSHOT_SCHEMA_VERSION,
      fixtureId,
      profile: flags.profile,
      createdAt: new Date().toISOString(),
      databases,
      systems: plan.systems,
    };
    writeManifest(dir, snapshot);

    const totalBytes = databases.reduce((n, d) => n + (d.sizeBytes ?? 0), 0);

    this.emit(
      flags,
      {
        fixtureId,
        dir,
        profile: flags.profile,
        databases: databases.length,
        totalBytes,
        systems: snapshot.systems ?? [],
      },
      [
        `stored snapshot '${fixtureId}' → ${dir}`,
        ...databases.map(
          (d) => `  ${d.db.padEnd(18)} ${formatBytes(d.sizeBytes ?? 0).padStart(10)}` +
            (d.schemaRev ? `  @${d.schemaRev}` : ''),
        ),
        `${databases.length} database(s), total ${formatBytes(totalBytes)}.`,
      ],
    );
  }
}

/**
 * Resolve a requested service set (`--only <svc,…>` ∪ `--with <bundle>` services,
 * already combined by `combineRequested`) to its closure's DB set (`DbId[]`).
 * Mirrors `status`'s `resolveServiceSet`: unknown ids fail with a friendly oclif
 * error. `withPlayback`/`withAuthz` keep their respective optional services in
 * the closure.
 */
export function closureDatabases(
  requested: ServiceId[],
  withPlayback: boolean,
  withAuthz: boolean,
  fail: (msg: string) => never,
): DbId[] {
  const known = new Set(Object.keys(manifest.services));
  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    fail(`unknown service id(s): ${unknown.join(', ')}\nknown: ${[...known].join(', ')}`);
  }

  return computeClosure(manifest, requested, { withPlayback, withAuthz }).databases;
}
