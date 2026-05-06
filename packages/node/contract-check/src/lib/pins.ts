// Loads + validates pins YAML files. Each pins file describes ONE event type
// owned by a single publisher service. Schema:
//
//   eventType: iam.user.created
//   publisher:
//       service: iam-api
//       package: '@saga-ed/iam-events'
//   versions_published: [1, 2]
//   consumers:
//       - service: programs-api
//         versions: [1, 2]
//         repo: <optional, for cross-repo>
//
// Files live at `apps/<svc>/pins/<eventType>.yaml` by convention. Loading is
// a flat read of the configured glob — no per-app aggregation, since each
// pins file is keyed by the `eventType` field, not by directory.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import fastGlob from 'fast-glob';
import { load as parseYaml } from 'js-yaml';

export interface PinsConsumer {
    service: string;
    versions: number[];
    /** Optional — for cross-repo consumers. Single-repo cases omit it. */
    repo?: string;
}

export interface PinsFile {
    eventType: string;
    publisher: { service: string; package: string };
    versions_published: number[];
    consumers: PinsConsumer[];
    /** Filesystem path of the loaded file (for error messages). */
    sourcePath: string;
}

export interface PinsValidationFailure {
    file: string;
    message: string;
}

/**
 * Glob + parse + structurally validate every pins file matching `pinsGlob`.
 * Returns parsed pins; any structural problem becomes a `failures[]` entry
 * (the caller decides how to surface it). The split lets the check tool
 * report multiple bad files in a single run.
 */
export async function loadPinsFiles(pinsGlob: string): Promise<{
    pins: PinsFile[];
    failures: PinsValidationFailure[];
}> {
    const paths = await fastGlob(pinsGlob, { absolute: true });
    const pins: PinsFile[] = [];
    const failures: PinsValidationFailure[] = [];

    for (const file of paths) {
        const raw = readFileSync(file, 'utf8');
        let parsed: unknown;
        try {
            parsed = parseYaml(raw);
        } catch (err) {
            failures.push({
                file,
                message: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
        }

        const validated = validateShape(parsed, file);
        if ('error' in validated) {
            failures.push({ file, message: validated.error });
            continue;
        }
        pins.push({ ...validated.value, sourcePath: file });
    }

    return { pins, failures };
}

type ShapeResult =
    | { value: Omit<PinsFile, 'sourcePath'> }
    | { error: string };

function validateShape(parsed: unknown, file: string): ShapeResult {
    if (!isRecord(parsed)) {
        return { error: 'Top-level must be a YAML object' };
    }

    const { eventType, publisher, versions_published, consumers } = parsed;

    if (typeof eventType !== 'string' || eventType.length === 0) {
        return { error: 'Missing or empty `eventType` (string)' };
    }
    if (
        !isRecord(publisher) ||
        typeof publisher.service !== 'string' ||
        typeof publisher.package !== 'string'
    ) {
        return { error: 'Missing `publisher: { service, package }`' };
    }
    if (!isVersionArray(versions_published)) {
        return { error: '`versions_published` must be a non-empty array of positive integers' };
    }
    if (!Array.isArray(consumers)) {
        return { error: '`consumers` must be an array (use [] for none)' };
    }

    const validatedConsumers: PinsConsumer[] = [];
    for (let i = 0; i < consumers.length; i++) {
        const c = consumers[i];
        if (!isRecord(c) || typeof c.service !== 'string' || !isVersionArray(c.versions)) {
            return {
                error: `consumers[${i}] must be { service: string, versions: number[] }`,
            };
        }
        const consumer: PinsConsumer = {
            service: c.service,
            versions: c.versions,
        };
        if (typeof c.repo === 'string') consumer.repo = c.repo;
        validatedConsumers.push(consumer);
    }

    // Sanity check: pins file's eventType should match its filename (less the
    // `.yaml` extension). Catches the common foot-gun of copy-pasting a pins
    // file and forgetting to rename one of the two. Use basename rather than
    // a forward-slash endsWith so adopters on Windows CI aren't surprised.
    const expectedFilename = `${eventType}.yaml`;
    if (basename(file) !== expectedFilename) {
        return {
            error: `Filename should be ${expectedFilename} to match eventType`,
        };
    }

    return {
        value: {
            eventType,
            publisher: {
                service: publisher.service as string,
                package: publisher.package as string,
            },
            versions_published: versions_published as number[],
            consumers: validatedConsumers,
        },
    };
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isVersionArray(v: unknown): v is number[] {
    return (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)
    );
}
