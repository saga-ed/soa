import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { PayloadDescriptor } from '@saga-ed/soa-event-envelope';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContractCheckConfig } from '../lib/config.js';
import { renderSnapshot } from '../lib/snapshot.js';
import { runExport } from '../export.js';

let tmp: string;

beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'soa-cc-export-'));
    // Tests pre-write into <tmp>/published/ before runExport runs (so we can
    // assert the "REFUSED" path), so the directory must already exist.
    mkdirSync(resolve(tmp, 'published'), { recursive: true });
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

const v1Schema = z.object({ id: z.string() });
const v1: PayloadDescriptor<z.infer<typeof v1Schema>> = {
    eventType: 'iam.user.created',
    eventVersion: 1,
    payloadSchema: v1Schema,
};

const v2Schema = z.object({ id: z.string(), status: z.string() });
const v2: PayloadDescriptor<z.infer<typeof v2Schema>> = {
    eventType: 'iam.user.created',
    eventVersion: 2,
    payloadSchema: v2Schema,
};

function makeConfig(registry: ContractCheckConfig['registry']): ContractCheckConfig {
    return {
        registry,
        publishedDir: resolve(tmp, 'published'),
        pinsGlob: null,
    };
}

describe('runExport — dry run (no write)', () => {
    it('reports every entry as new when publishedDir is empty', () => {
        const summary = runExport(makeConfig({ 'iam.user.created.v1': v1 }));
        expect(summary.written).toBe(false);
        expect(summary.newCount).toBe(1);
        expect(summary.modifiedCount).toBe(0);
        expect(summary.refusedCount).toBe(0);
        expect(summary.results[0].isNew).toBe(true);
        expect(summary.results[0].changed).toBe(true);
        // No file written.
        expect(existsSync(resolve(tmp, 'published/iam.user.created-v1.json'))).toBe(false);
    });

    it('reports zero modifications when committed snapshots match the registry', () => {
        const dir = resolve(tmp, 'published');
        writeFileSync(
            resolve(tmp, 'published/iam.user.created-v1.json'),
            renderSnapshot('iam.user.created.v1', v1),
        );
        const summary = runExport({ ...makeConfig({ 'iam.user.created.v1': v1 }), publishedDir: dir });
        expect(summary.newCount).toBe(0);
        expect(summary.modifiedCount).toBe(0);
        expect(summary.results[0].isNew).toBe(false);
        expect(summary.results[0].changed).toBe(false);
    });

    it('detects a modified existing snapshot without overwriting it', () => {
        // Pre-write a stale (v2) snapshot at the v1 path.
        writeFileSync(
            resolve(tmp, 'published/iam.user.created-v1.json'),
            renderSnapshot('iam.user.created.v2', v2),
        );
        const before = readFileSync(resolve(tmp, 'published/iam.user.created-v1.json'), 'utf8');
        const summary = runExport(makeConfig({ 'iam.user.created.v1': v1 }));
        expect(summary.modifiedCount).toBe(1);
        expect(summary.results[0].isNew).toBe(false);
        expect(summary.results[0].changed).toBe(true);
        // File was not modified — dry run.
        expect(readFileSync(resolve(tmp, 'published/iam.user.created-v1.json'), 'utf8')).toBe(
            before,
        );
    });
});

describe('runExport — write mode', () => {
    it('writes new snapshots verbatim from renderSnapshot', () => {
        const summary = runExport(makeConfig({ 'iam.user.created.v1': v1 }), { write: true });
        expect(summary.newCount).toBe(1);
        expect(summary.refusedCount).toBe(0);
        const written = readFileSync(
            resolve(tmp, 'published/iam.user.created-v1.json'),
            'utf8',
        );
        expect(written).toBe(renderSnapshot('iam.user.created.v1', v1));
    });

    it('creates publishedDir when missing', () => {
        // Use a deep path that doesn't exist yet; mkdirSync({ recursive: true })
        // should create the chain.
        const config: ContractCheckConfig = {
            registry: { 'iam.user.created.v1': v1 },
            publishedDir: resolve(tmp, 'never/created/published'),
            pinsGlob: null,
        };
        runExport(config, { write: true });
        expect(existsSync(resolve(tmp, 'never/created/published'))).toBe(true);
    });

    it('REFUSES to overwrite an existing modified snapshot without --bump (allowModify)', () => {
        // Pre-write a stale snapshot.
        const path = resolve(tmp, 'published/iam.user.created-v1.json');
        writeFileSync(path, renderSnapshot('iam.user.created.v2', v2));
        const before = readFileSync(path, 'utf8');

        const summary = runExport(makeConfig({ 'iam.user.created.v1': v1 }), { write: true });
        expect(summary.refusedCount).toBe(1);
        expect(summary.results[0].refusedWrite).toBe(true);
        // File MUST be unchanged — this is the load-bearing test for the
        // D5/D6 frozen-forever guarantee. If this regresses, `export --write`
        // can silently launder a schema modification through committed bytes.
        expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('overwrites a modified snapshot when allowModify (--bump) is set', () => {
        const path = resolve(tmp, 'published/iam.user.created-v1.json');
        writeFileSync(path, renderSnapshot('iam.user.created.v2', v2));

        const summary = runExport(makeConfig({ 'iam.user.created.v1': v1 }), {
            write: true,
            allowModify: true,
        });
        expect(summary.refusedCount).toBe(0);
        expect(summary.modifiedCount).toBe(1);
        expect(readFileSync(path, 'utf8')).toBe(renderSnapshot('iam.user.created.v1', v1));
    });

    it('always writes new snapshots even without --bump', () => {
        // A new event being added is not a D5/D6 violation; --bump is only
        // needed for modifying an EXISTING snapshot.
        const summary = runExport(
            makeConfig({ 'iam.user.created.v1': v1, 'iam.user.created.v2': v2 }),
            { write: true },
        );
        expect(summary.newCount).toBe(2);
        expect(summary.refusedCount).toBe(0);
        expect(existsSync(resolve(tmp, 'published/iam.user.created-v1.json'))).toBe(true);
        expect(existsSync(resolve(tmp, 'published/iam.user.created-v2.json'))).toBe(true);
    });
});

describe('runExport — registry consistency', () => {
    it('throws when an entry key disagrees with its descriptor (key/descriptor drift)', () => {
        // Wrong key — caught by assertRegistryConsistent before any I/O.
        expect(() => runExport(makeConfig({ 'iam.user.created.v99': v1 }))).toThrow(/registry key/);
    });
});
