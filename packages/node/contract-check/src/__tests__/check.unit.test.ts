import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PayloadDescriptor } from '@saga-ed/soa-event-envelope';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../check.js';
import type { ContractCheckConfig } from '../lib/config.js';
import { renderSnapshot } from '../lib/snapshot.js';

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'soa-cc-check-'));
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

const userCreatedV1Schema = z.object({ id: z.string() });
const userCreatedV1: PayloadDescriptor<z.infer<typeof userCreatedV1Schema>> = {
    eventType: 'iam.user.created',
    eventVersion: 1,
    payloadSchema: userCreatedV1Schema,
};

const userCreatedV2Schema = z.object({ id: z.string(), status: z.string() });
const userCreatedV2: PayloadDescriptor<z.infer<typeof userCreatedV2Schema>> = {
    eventType: 'iam.user.created',
    eventVersion: 2,
    payloadSchema: userCreatedV2Schema,
};

function writeSnapshot(
    publishedDir: string,
    eventKey: string,
    descriptor: PayloadDescriptor<unknown>,
): void {
    mkdirSync(publishedDir, { recursive: true });
    const filename = eventKey.replace(/\.v(\d+)$/, '-v$1') + '.json';
    writeFileSync(resolve(publishedDir, filename), renderSnapshot(eventKey, descriptor));
}

function writePins(file: string, body: string): void {
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, body);
}

function makeConfig(opts: {
    registry: ContractCheckConfig['registry'];
    pinsGlob?: string | null;
}): ContractCheckConfig {
    return {
        registry: opts.registry,
        publishedDir: resolve(tmp, 'published'),
        pinsGlob: opts.pinsGlob === undefined ? null : opts.pinsGlob,
    };
}

describe('runCheck — snapshot layer', () => {
    it('returns no failures when every registry entry has a matching snapshot', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
        });
        const result = await runCheck(config);
        expect(result.failures).toEqual([]);
        expect(result.eventCount).toBe(1);
    });

    it('reports a `snapshot` failure when a registered event has no committed snapshot', async () => {
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
        });
        const result = await runCheck(config);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].layer).toBe('snapshot');
        expect(result.failures[0].message).toMatch(/Missing snapshot.*export --write/);
    });

    it('reports a `snapshot` failure when committed bytes differ from the registry schema (frozen-forever)', async () => {
        // Pre-write an outdated snapshot (v2 schema bytes for the v1 key — drift).
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV2);
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
        });
        const result = await runCheck(config);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].layer).toBe('snapshot');
        expect(result.failures[0].message).toMatch(/frozen-forever|forbidden/);
    });
});

describe('runCheck — pins-coverage layer', () => {
    it('skips pins layers when pinsGlob is null', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
            pinsGlob: null,
        });
        const result = await runCheck(config);
        expect(result.failures).toEqual([]);
        expect(result.pinsCount).toBe(0);
    });

    it('reports `pins-coverage` when a registered event has no pins file', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        const pinsFailures = result.failures.filter((f) => f.layer === 'pins-coverage');
        expect(pinsFailures).toHaveLength(1);
        expect(pinsFailures[0].message).toMatch(/no pins file exists/);
    });

    it('reports `pins-coverage` when versions_published is missing a registry version', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v2', userCreatedV2);
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.created.yaml`,
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1]
consumers: []
`,
        );
        const config = makeConfig({
            registry: {
                'iam.user.created.v1': userCreatedV1,
                'iam.user.created.v2': userCreatedV2,
            },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        const pinsFailures = result.failures.filter((f) => f.layer === 'pins-coverage');
        expect(pinsFailures).toHaveLength(1);
        expect(pinsFailures[0].message).toMatch(/missing from versions_published/);
    });

    it('reports `pins-coverage` when versions_published has an extra version not in the registry', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.created.yaml`,
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1, 2]
consumers: []
`,
        );
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        const pinsFailures = result.failures.filter((f) => f.layer === 'pins-coverage');
        expect(pinsFailures).toHaveLength(1);
        expect(pinsFailures[0].message).toMatch(/no schema in the registry/);
    });

    it('reports `pins-coverage` when a pins file declares an event the registry does not know', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.created.yaml`,
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1]
consumers: []
`,
        );
        // Stray pins for an event not in the registry.
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.deleted.yaml`,
            `eventType: iam.user.deleted
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1]
consumers: []
`,
        );
        const config = makeConfig({
            registry: { 'iam.user.created.v1': userCreatedV1 },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        const pinsFailures = result.failures.filter((f) => f.layer === 'pins-coverage');
        expect(pinsFailures).toHaveLength(1);
        expect(pinsFailures[0].message).toMatch(/no schema for it exists/);
    });
});

describe('runCheck — pins-validity layer (drop-protection)', () => {
    it('reports `pins-validity` when a consumer pins a version no longer in versions_published', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v2', userCreatedV2);
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.created.yaml`,
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [2]
consumers:
    - service: programs-api
      versions: [1, 2]
`,
        );
        const config = makeConfig({
            registry: { 'iam.user.created.v2': userCreatedV2 },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        const validityFailures = result.failures.filter((f) => f.layer === 'pins-validity');
        expect(validityFailures).toHaveLength(1);
        expect(validityFailures[0].message).toMatch(/programs-api pins.*\[1\]/);
    });

    it('passes when every consumer pin is a subset of versions_published', async () => {
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v1', userCreatedV1);
        writeSnapshot(resolve(tmp, 'published'), 'iam.user.created.v2', userCreatedV2);
        writePins(
            `${tmp}/apps/iam-api/pins/iam.user.created.yaml`,
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1, 2]
consumers:
    - service: programs-api
      versions: [1, 2]
    - service: scheduling-api
      versions: [2]
`,
        );
        const config = makeConfig({
            registry: {
                'iam.user.created.v1': userCreatedV1,
                'iam.user.created.v2': userCreatedV2,
            },
            pinsGlob: `${tmp}/apps/*/pins/*.yaml`,
        });
        const result = await runCheck(config);
        expect(result.failures).toEqual([]);
    });
});

describe('runCheck — registry consistency', () => {
    it('throws when an entry key disagrees with its descriptor (key/descriptor drift)', async () => {
        // The key says v2 but the descriptor is v1 — the snapshot path would
        // be derived from the key while pins-coverage uses the descriptor's
        // fields, producing inconsistent output across layers. Catch loudly.
        const config = makeConfig({
            registry: { 'iam.user.created.v2': userCreatedV1 },
        });
        await expect(runCheck(config)).rejects.toThrow(/registry key/);
    });
});
