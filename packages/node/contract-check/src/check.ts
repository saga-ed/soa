// Validates publisher snapshots + publisher-owned pins files. Three layers:
//
//   1. SNAPSHOT BYTE-DIFF — exporting the registry must produce exactly the
//      snapshots currently in `publishedDir`. Any diff means a frozen schema
//      was modified or a new version was added without committing it.
//
//   2. PINS COVERAGE — for every event type with a registry entry, a pins
//      file must exist matching `pinsGlob`, and its `versions_published`
//      must equal the set of versions in the registry. Catches "publisher
//      added/dropped a schema but didn't update pins."
//
//   3. PINS CONSUMER VALIDITY (drop-protection) — every consumer pin's
//      `versions[]` must be a subset of `versions_published`. When a
//      publisher's PR shrinks `versions_published`, this fails until
//      consumers drop their pins.
//
// Returns a list of failures; CLI maps non-empty list to exit 1.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRegistryConsistent, type ContractCheckConfig } from './lib/config.js';
import { loadPinsFiles, type PinsFile } from './lib/pins.js';
import { renderSnapshot, snapshotFilename } from './lib/snapshot.js';

export interface CheckFailure {
    layer: 'snapshot' | 'pins-coverage' | 'pins-validity';
    file: string;
    message: string;
}

export interface CheckResult {
    failures: CheckFailure[];
    eventCount: number;
    pinsCount: number;
}

function checkSnapshots(config: ContractCheckConfig): CheckFailure[] {
    const failures: CheckFailure[] = [];
    for (const [eventKey, descriptor] of Object.entries(config.registry)) {
        const filename = snapshotFilename(eventKey);
        const target = resolve(config.publishedDir, filename);
        const expected = renderSnapshot(eventKey, descriptor, config.snapshotIdPrefix);

        if (!existsSync(target)) {
            failures.push({
                layer: 'snapshot',
                file: filename,
                message:
                    `Missing snapshot ${filename} for ${eventKey}. ` +
                    'Run `soa-contract-check export --write` and commit the new file.',
            });
            continue;
        }

        const committed = readFileSync(target, 'utf8');
        if (committed !== expected) {
            failures.push({
                layer: 'snapshot',
                file: filename,
                message:
                    `Snapshot ${filename} differs from current schema for ${eventKey}. ` +
                    'Per Model A (frozen-forever), modifying an existing version is forbidden. ' +
                    'Either revert the change or bump to a new version.',
            });
        }
    }
    return failures;
}

async function checkPinsLayer(
    config: ContractCheckConfig,
): Promise<{ failures: CheckFailure[]; pinsCount: number }> {
    if (config.pinsGlob === null) {
        return { failures: [], pinsCount: 0 };
    }

    const failures: CheckFailure[] = [];
    const { pins, failures: loadFailures } = await loadPinsFiles(config.pinsGlob);

    for (const f of loadFailures) {
        failures.push({ layer: 'pins-validity', file: f.file, message: f.message });
    }

    // Map eventType → registered versions.
    const registryVersions = new Map<string, Set<number>>();
    for (const descriptor of Object.values(config.registry)) {
        const versions = registryVersions.get(descriptor.eventType) ?? new Set();
        versions.add(descriptor.eventVersion);
        registryVersions.set(descriptor.eventType, versions);
    }

    // Index pins by eventType + flag duplicates.
    const pinsByEventType = new Map<string, PinsFile>();
    for (const p of pins) {
        const existing = pinsByEventType.get(p.eventType);
        if (existing) {
            failures.push({
                layer: 'pins-coverage',
                file: p.sourcePath,
                message: `Duplicate pins file for ${p.eventType} (also at ${existing.sourcePath}).`,
            });
            continue;
        }
        pinsByEventType.set(p.eventType, p);
    }

    // Layer 2a: every registered eventType must have a pins file with
    // versions_published equal to the registry's version set.
    for (const [eventType, regSet] of registryVersions) {
        const pinsFile = pinsByEventType.get(eventType);
        if (!pinsFile) {
            failures.push({
                layer: 'pins-coverage',
                file: `apps/<publisher>/pins/${eventType}.yaml`,
                message:
                    `Registry has ${eventType} but no pins file exists. ` +
                    'Create the pins file with versions_published equal to the registry versions.',
            });
            continue;
        }
        const pubSet = new Set(pinsFile.versions_published);
        const missing = [...regSet].filter((v) => !pubSet.has(v)).sort((a, b) => a - b);
        const extra = [...pubSet].filter((v) => !regSet.has(v)).sort((a, b) => a - b);
        if (missing.length > 0 || extra.length > 0) {
            const parts: string[] = [];
            if (missing.length > 0) {
                parts.push(`registry has [${missing.join(', ')}] missing from versions_published`);
            }
            if (extra.length > 0) {
                parts.push(
                    `versions_published has [${extra.join(', ')}] with no schema in the registry`,
                );
            }
            failures.push({
                layer: 'pins-coverage',
                file: pinsFile.sourcePath,
                message: `versions_published doesn't match the registry for ${eventType}: ${parts.join('; ')}.`,
            });
        }
    }

    // Layer 2b: pins file for an event the registry doesn't know about.
    for (const [eventType, pinsFile] of pinsByEventType) {
        if (!registryVersions.has(eventType)) {
            failures.push({
                layer: 'pins-coverage',
                file: pinsFile.sourcePath,
                message:
                    `Pins file declares ${eventType} but no schema for it exists in the registry. ` +
                    'Either remove this pins file or add the schema.',
            });
        }
    }

    // Layer 3: every consumer pin must be a subset of versions_published.
    // This is the drop-protection check.
    for (const pinsFile of pins) {
        const pubSet = new Set(pinsFile.versions_published);
        for (const consumer of pinsFile.consumers) {
            const stalePins = consumer.versions.filter((v) => !pubSet.has(v));
            if (stalePins.length > 0) {
                failures.push({
                    layer: 'pins-validity',
                    file: pinsFile.sourcePath,
                    message:
                        `${consumer.service} pins ${pinsFile.eventType} version(s) [${stalePins.join(', ')}] ` +
                        `but versions_published is [${pinsFile.versions_published.join(', ')}]. ` +
                        `Either restore those versions to versions_published, or have ${consumer.service} drop the pin first.`,
                });
            }
        }
    }

    return { failures, pinsCount: pins.length };
}

export async function runCheck(config: ContractCheckConfig): Promise<CheckResult> {
    assertRegistryConsistent(config);
    const snapshotFailures = checkSnapshots(config);
    const { failures: pinsFailures, pinsCount } = await checkPinsLayer(config);
    return {
        failures: [...snapshotFailures, ...pinsFailures],
        eventCount: Object.keys(config.registry).length,
        pinsCount,
    };
}
