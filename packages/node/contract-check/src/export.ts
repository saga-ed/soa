// Renders every event's payload schema to JSON Schema and writes one file per
// (eventType, eventVersion) under `publishedDir`. Files are committed to git;
// `runCheck()` then fails if any committed snapshot has drifted from the
// schema, OR if a new version was added without committing its snapshot.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRegistryConsistent, type ContractCheckConfig } from './lib/config.js';
import { renderSnapshot, snapshotFilename } from './lib/snapshot.js';

export interface ExportResult {
    eventKey: string;
    filename: string;
    json: string;
    changed: boolean;
    isNew: boolean;
    /**
     * True when `opts.write` was set but the write was refused because the
     * snapshot would have overwritten an existing file with different bytes
     * and `opts.allowModify` was not set. The caller should treat this as a
     * D5/D6 violation: the developer should bump to a new version, not edit
     * the committed schema.
     */
    refusedWrite: boolean;
}

export interface ExportSummary {
    results: ExportResult[];
    written: boolean;
    newCount: number;
    modifiedCount: number;
    /** Count of `results` with `refusedWrite: true`. */
    refusedCount: number;
}

export interface ExportOpts {
    /** Write snapshots to disk. Default: false (dry-run / diff-only). */
    write?: boolean;
    /**
     * Allow `write` to overwrite existing snapshots whose bytes have changed.
     * Wired to `--bump` on the CLI. Default: false — modifying an existing
     * version is a D5/D6 violation, so a developer must opt in explicitly.
     * New snapshots (no prior file on disk) are always written by `write`.
     */
    allowModify?: boolean;
}

export function runExport(
    config: ContractCheckConfig,
    opts: ExportOpts = {},
): ExportSummary {
    assertRegistryConsistent(config);
    mkdirSync(config.publishedDir, { recursive: true });

    const existing = new Map<string, string>();
    if (existsSync(config.publishedDir)) {
        for (const f of readdirSync(config.publishedDir)) {
            if (f.endsWith('.json')) {
                existing.set(f, readFileSync(resolve(config.publishedDir, f), 'utf8'));
            }
        }
    }

    const results: ExportResult[] = [];
    let newCount = 0;
    let modifiedCount = 0;
    let refusedCount = 0;
    for (const [eventKey, descriptor] of Object.entries(config.registry)) {
        const filename = snapshotFilename(eventKey);
        const json = renderSnapshot(eventKey, descriptor, config.snapshotIdPrefix);
        const previous = existing.get(filename);
        const changed = previous !== json;
        const isNew = previous === undefined;
        const wouldModifyExisting = changed && !isNew;
        const refusedWrite =
            (opts.write ?? false) && wouldModifyExisting && !(opts.allowModify ?? false);

        results.push({ eventKey, filename, json, changed, isNew, refusedWrite });
        if (isNew) newCount++;
        else if (changed) modifiedCount++;
        if (refusedWrite) refusedCount++;

        if (opts.write && !refusedWrite) {
            writeFileSync(resolve(config.publishedDir, filename), json);
        }
    }

    return {
        results,
        written: opts.write ?? false,
        newCount,
        modifiedCount,
        refusedCount,
    };
}
