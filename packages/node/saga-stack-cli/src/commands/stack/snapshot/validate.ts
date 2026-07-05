/**
 * `saga-stack stack snapshot validate <fixture-id>` — offline structural check
 * of a snapshot (plan §4.3, §7.2 "M3"). Exit-code-as-gate: exits 1 on any
 * structural failure (mirrors mesh-fixture-cli's `snapshot:validate` contract,
 * rebuilt as a file-structure check — the tRPC/HTTP registry validation is
 * dropped per plan §4.4).
 *
 * Default mode is OFFLINE: parse the manifest, then confirm every recorded dump
 * file EXISTS and is non-empty. `--deep` additionally runs `pg_restore --list`
 * on each postgres dump (so a truncated/corrupt archive is caught) — this needs
 * the postgres container running (for the pg_restore binary), so the command
 * asserts that first.
 *
 * THIN: the pure `validatePlan` enumerates the checks; the runtime stats the
 * files (+ optional `pg_restore --list` via `this.getSnapshotIO()`); the pure
 * `evaluateValidation` renders the verdict.
 *
 *   node bin/dev.js stack snapshot validate demo-small
 *   node bin/dev.js stack snapshot validate demo-small --deep
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../../base-command.js';
import { deriveInstance } from '../../../core/derive-instance.js';
import { evaluateValidation, safeParseSnapshotManifest, validatePlan } from '../../../core/snapshot/index.js';
import type { ObservedFile } from '../../../core/snapshot/index.js';
import {
  fileSize,
  postgresContainer,
  readManifest,
  snapshotDir,
  snapshotExists,
} from '../../../runtime/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default class SnapshotValidate extends BaseCommand {
  static description =
    'Structurally validate a snapshot (dump files present + non-empty; --deep parses each pg archive). Exits 1 on failure.';

  static examples = [
    '<%= config.bin %> <%= command.id %> demo-small',
    '<%= config.bin %> <%= command.id %> demo-small --deep',
  ];

  static args = {
    'fixture-id': Args.string({ description: 'fixture identifier to validate', required: true }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    deep: Flags.boolean({
      description: 'also run `pg_restore --list` on each postgres dump (needs the pg container up)',
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
    const { args, flags } = await this.parse(SnapshotValidate);
    // M13-A: apply the slot env seam BEFORE any snapshot-store resolver runs —
    // snapshotsRoot()/postgresContainer()/… read $SAGA_MESH_* at call time.
    this.applyInstanceEnv(deriveInstance({ slot: flags.slot }));
    const fixtureId = args['fixture-id'];
    const dir = snapshotDir(fixtureId);

    // A missing dir or an unparseable manifest is the first validation failure.
    if (!snapshotExists(fixtureId)) {
      this.reportInvalid(flags, fixtureId, `snapshot '${fixtureId}' not found at ${dir}`);
      return;
    }
    const manifestPath = join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      this.reportInvalid(flags, fixtureId, `manifest.json not found at ${manifestPath}`);
      return;
    }
    const snapshot = readManifest(dir);
    if (snapshot === null) {
      // existsSync true but readManifest null ⇒ corrupt JSON or schema mismatch.
      const detail = describeParseError(manifestPath);
      this.reportInvalid(flags, fixtureId, `manifest.json failed to parse/validate: ${detail}`);
      return;
    }

    const plan = validatePlan(dir, snapshot, { deep: flags.deep });

    const io = this.getSnapshotIO();
    if (flags.deep && plan.checks.some((c) => c.pgRestoreList)) {
      await io.assertPgRunning(postgresContainer());
    }

    const pgC = postgresContainer();
    const observed = new Map<string, ObservedFile>();
    for (const check of plan.checks) {
      const exists = existsSync(check.path);
      const obs: ObservedFile = {
        path: check.path,
        exists,
        sizeBytes: exists ? fileSize(check.path) : 0,
      };
      if (check.pgRestoreList && exists) {
        obs.pgRestoreOk = await io.pgRestoreList(pgC, check.path);
      }
      observed.set(check.path, obs);
    }

    const result = evaluateValidation(plan, observed);

    this.emit(
      flags,
      {
        fixtureId: result.fixtureId,
        ok: result.ok,
        deep: flags.deep,
        checks: plan.checks.length,
        failures: result.failures,
      },
      result.ok
        ? [`snapshot '${fixtureId}' OK — ${plan.checks.length} dump file(s) validated${flags.deep ? ' (deep)' : ''}.`]
        : [
            `snapshot '${fixtureId}' FAILED validation:`,
            ...result.failures.map((f) => `  ✗ ${f.db.padEnd(18)} ${f.reason}: ${f.detail}`),
          ],
    );

    if (!result.ok) this.exit(1);
  }

  /** Emit a structural failure verdict and exit 1 (the gate). */
  private reportInvalid(
    flags: { porcelain: boolean; 'output-json': boolean },
    fixtureId: string,
    detail: string,
  ): void {
    this.emit(
      flags,
      { fixtureId, ok: false, failures: [{ db: null, reason: 'manifest', detail }] },
      [`snapshot '${fixtureId}' FAILED validation:`, `  ✗ ${detail}`],
    );
    this.exit(1);
  }
}

/** Best-effort one-line reason a manifest failed to parse (for the failure detail). */
function describeParseError(path: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return `invalid JSON (${err instanceof Error ? err.message : String(err)})`;
  }
  const parsed = safeParseSnapshotManifest(raw);
  if (parsed.success) return 'unknown';
  return parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
}
