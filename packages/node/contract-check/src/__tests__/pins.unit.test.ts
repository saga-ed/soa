import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPinsFiles } from '../lib/pins.js';

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'soa-contract-check-pins-'));
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

function writePins(svc: string, eventType: string, body: string): string {
    const dir = resolve(tmp, 'apps', svc, 'pins');
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${eventType}.yaml`);
    writeFileSync(file, body);
    return file;
}

describe('loadPinsFiles', () => {
    it('loads a well-formed pins file', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.user.created
publisher:
    service: iam-api
    package: '@saga-ed/iam-events'
versions_published: [1, 2]
consumers:
    - service: programs-api
      versions: [1, 2]
`,
        );

        const { pins, failures } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(failures).toEqual([]);
        expect(pins).toHaveLength(1);
        expect(pins[0].eventType).toBe('iam.user.created');
        expect(pins[0].publisher.service).toBe('iam-api');
        expect(pins[0].versions_published).toEqual([1, 2]);
        expect(pins[0].consumers).toEqual([
            { service: 'programs-api', versions: [1, 2] },
        ]);
    });

    it('records optional cross-repo `repo` field on consumers', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.user.created
publisher:
    service: iam-api
    package: '@saga-ed/iam-events'
versions_published: [1]
consumers:
    - service: programs-api
      versions: [1]
      repo: saga-ed/program-hub
`,
        );

        const { pins } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(pins[0].consumers[0].repo).toBe('saga-ed/program-hub');
    });

    it('reports invalid YAML as a failure (not a thrown exception)', async () => {
        writePins('iam-api', 'iam.user.created', '::: not yaml :::\n  - oops');
        const { pins, failures } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(pins).toEqual([]);
        expect(failures).toHaveLength(1);
        expect(failures[0].message).toMatch(/Invalid YAML/);
    });

    it('rejects a missing publisher block', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.user.created
versions_published: [1]
consumers: []
`,
        );
        const { failures } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(failures[0].message).toMatch(/publisher/);
    });

    it('rejects a versions_published with non-positive integers', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.user.created
publisher:
    service: iam-api
    package: '@saga-ed/iam-events'
versions_published: [0, 1]
consumers: []
`,
        );
        const { failures } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(failures[0].message).toMatch(/versions_published/);
    });

    it('rejects a filename that does not match the eventType (copy-paste foot-gun)', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.group.created
publisher:
    service: iam-api
    package: '@saga-ed/iam-events'
versions_published: [1]
consumers: []
`,
        );
        const { failures } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        expect(failures[0].message).toMatch(/Filename should be/);
    });

    it('returns multiple pins from multiple services', async () => {
        writePins(
            'iam-api',
            'iam.user.created',
            `eventType: iam.user.created
publisher: { service: iam-api, package: '@saga-ed/iam-events' }
versions_published: [1]
consumers: []
`,
        );
        writePins(
            'programs-api',
            'programs.program.created',
            `eventType: programs.program.created
publisher: { service: programs-api, package: '@saga-ed/programs-events' }
versions_published: [1]
consumers: []
`,
        );
        const { pins } = await loadPinsFiles(`${tmp}/apps/*/pins/*.yaml`);
        const names = pins.map((p) => p.eventType).sort();
        expect(names).toEqual(['iam.user.created', 'programs.program.created']);
    });
});
