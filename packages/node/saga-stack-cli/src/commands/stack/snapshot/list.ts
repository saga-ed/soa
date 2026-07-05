/**
 * `saga-stack stack snapshot list` — enumerate snapshots on disk (plan §4.3,
 * §7.2 "M3"). Read-only; supersedes mesh-fixture-cli's `snapshot:list` and
 * subsumes its `snapshot:show` (use `--output-json` for the full manifest).
 *
 * Scans `$SAGA_MESH_SNAPSHOTS_DIR` (default ~/.saga-mesh/snapshots), newest
 * first. Default view is one compact row per snapshot (id, profile, #DBs, size,
 * date); `-v/--verbose` lists each DB and its migration head underneath.
 *
 *   node bin/dev.js stack snapshot list
 *   node bin/dev.js stack snapshot list -v
 *   node bin/dev.js stack snapshot list --output-json
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { deriveInstance } from '../../../core/derive-instance.js';
import { formatBytes, scanSnapshots, snapshotsRoot } from '../../../runtime/index.js';

export default class SnapshotList extends BaseCommand {
  static description = 'List the snapshots on disk under $SAGA_MESH_SNAPSHOTS_DIR (read-only).';

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> -v',
    '<%= config.bin %> <%= command.id %> --output-json',
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    verbose: Flags.boolean({
      char: 'v',
      description: 'list each DB and its migration head under every snapshot',
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

  async run(): Promise<void> {
    const { flags } = await this.parse(SnapshotList);
    // M13-A: apply the slot env seam BEFORE any snapshot-store resolver runs —
    // snapshotsRoot()/postgresContainer()/… read $SAGA_MESH_* at call time.
    this.applyInstanceEnv(deriveInstance({ slot: flags.slot }));
    const entries = scanSnapshots();

    if (flags['output-json']) {
      this.log(
        JSON.stringify(
          entries.map((e) => ({
            fixtureId: e.fixtureId,
            path: e.path,
            sizeBytes: e.sizeBytes,
            modifiedAt: e.mtime.toISOString(),
            manifest: e.manifest,
          })),
          null,
          2,
        ),
      );
      return;
    }

    if (entries.length === 0) {
      if (!flags.porcelain) {
        this.log(`No snapshots found under ${snapshotsRoot()}.`);
        this.log('  Create one: saga-stack stack snapshot store --fixture-id <name>');
      }
      return;
    }

    if (flags.porcelain) {
      for (const e of entries) {
        const profile = e.manifest?.profile ?? '';
        const dbs = e.manifest?.databases.length ?? 0;
        // Field 6 (APPENDED, never inserted — fields 1-5 stay positional): the
        // M14 checkpoint provenance `spa/flow@stage`, empty for plain snapshots.
        const flow = e.manifest?.flow;
        const flowRef = flow ? `${flow.spa}/${flow.flow}@${flow.stageId}` : '';
        this.log(`${e.fixtureId}\t${profile}\t${dbs}\t${e.sizeBytes}\t${e.mtime.toISOString()}\t${flowRef}`);
      }
      return;
    }

    // ── Aligned table: widths sized to the data (id capped so a stray long id
    //    can't blow the layout out). ──
    const idW = clamp(Math.max(2, ...entries.map((e) => e.fixtureId.length)), 4, 28);
    const profW = Math.max(7, ...entries.map((e) => (e.manifest?.profile ?? '—').length));
    const row = (id: string, prof: string, dbs: string, size: string, when: string): string =>
      `  ${id.padEnd(idW)}  ${prof.padEnd(profW)}  ${dbs.padStart(4)}  ${size.padStart(9)}  ${when}`;

    this.log(`Snapshots under ${snapshotsRoot()}:`);
    this.log('');
    const header = row('ID', 'PROFILE', 'DBS', 'SIZE', 'MODIFIED');
    this.log(header);
    this.log('  ' + '─'.repeat(header.length - 2));

    for (const e of entries) {
      const profile = e.manifest?.profile ?? '—';
      const dbs = e.manifest?.databases.length ?? 0;
      this.log(
        row(e.fixtureId, profile, String(dbs), formatBytes(e.sizeBytes), friendlyDate(e.mtime)),
      );
      // M14: a stage checkpoint's provenance as an indented sub-line (a column
      // would misalign — checkpoint fixtureIds exceed the 28-char id cap).
      const flow = e.manifest?.flow;
      if (flow) {
        const phase = flow.phase !== undefined ? ` (s${flow.phase})` : '';
        this.log(
          `        flow: ${flow.spa}/${flow.flow} @ ${flow.stageId}${phase} — baked ${flow.bakedAt.slice(0, 10)}, occurrence ${flow.dates.occurrenceDate}`,
        );
      }
      if (flags.verbose) {
        const dbW = clamp(Math.max(2, ...(e.manifest?.databases ?? []).map((d) => d.db.length)), 4, 22);
        for (const d of e.manifest?.databases ?? []) {
          this.log(`        ${d.db.padEnd(dbW)}  ${migrationHead(d)}`);
        }
      }
    }

    if (!flags.verbose && entries.some((e) => (e.manifest?.databases.length ?? 0) > 0)) {
      this.log('');
      this.log('  (-v / --verbose lists each DB + its migration head)');
    }
  }
}

/** `2026-07-01 20:09 UTC` — the ISO timestamp trimmed to minutes. */
function friendlyDate(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The readable migration head for a DB row: drop the `<timestamp>_` prefix. */
function migrationHead(d: { schemaRev: string | null; engine: string }): string {
  if (d.schemaRev) return d.schemaRev.replace(/^\d+_/, '');
  return d.engine === 'mongo' ? '(mongo — no migrations)' : '(no migration history)';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
