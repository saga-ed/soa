// Renders every event's payload schema to JSON Schema and writes one file per
// (eventType, eventVersion) under `publishedDir`. Files are committed to git;
// the next `runCheck()` fails if a write here would diff against the
// committed snapshot, OR if the developer hasn't passed `--bump` to indicate
// the change is intentional.

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ContractCheckConfig } from './lib/config.js';
import { renderSnapshot, snapshotFilename } from './lib/snapshot.js';

export interface ExportResult {
    eventKey: string;
    filename: string;
    json: string;
    changed: boolean;
    isNew: boolean;
}

export interface ExportSummary {
    results: ExportResult[];
    written: boolean;
    newCount: number;
    modifiedCount: number;
}

export interface ExportOpts {
    /** Write snapshots to disk. Default: false (dry-run / diff-only). */
    write?: boolean;
}

export function runExport(
    config: ContractCheckConfig,
    opts: ExportOpts = {},
): ExportSummary {
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
    for (const [eventKey, descriptor] of Object.entries(config.registry)) {
        const filename = snapshotFilename(eventKey);
        const json = renderSnapshot(eventKey, descriptor, config.snapshotIdPrefix);
        const previous = existing.get(filename);
        const changed = previous !== json;
        const isNew = previous === undefined;
        results.push({ eventKey, filename, json, changed, isNew });
        if (isNew) newCount++;
        else if (changed) modifiedCount++;
        if (opts.write) {
            writeFileSync(resolve(config.publishedDir, filename), json);
        }
    }

    return {
        results,
        written: opts.write ?? false,
        newCount,
        modifiedCount,
    };
}
