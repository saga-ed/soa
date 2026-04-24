import 'reflect-metadata';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Controller } from 'routing-controllers';
import { injectable } from 'inversify';

vi.mock('@saga-ed/infra-compose', () => ({
    get_active_profile: vi.fn(() => ({ profile: 'small' })),
    snapshot: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
    switch_profile: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
    reset: vi.fn(async () => ({ status: 0, stdout: '', stderr: '' })),
}));

vi.mock('@saga-ed/infra-compose/router', async () => {
    const { Router } = await import('express');
    return { create_router: vi.fn(() => Router()) };
});

vi.mock('@saga-ed/soa-db', async () => {
    const actual = await vi.importActual<any>('@saga-ed/soa-db');
    const { MockMongoProvider } = await import('@saga-ed/soa-db/mocks/mock-mongo-provider');
    class TestMongoProvider extends MockMongoProvider {
        constructor(config: any) {
            super(config?.instanceName ?? 'test-db');
        }
    }
    return { ...actual, MongoProvider: TestMongoProvider };
});

import { AbstractFixtureController } from '../controller/abstract-fixture-controller.js';
import type { FixtureTypeDefinition } from '../types.js';
import { FixtureServer } from '../server/fixture-server.js';

@injectable()
@Controller('/testfx')
class TestFixtureController extends AbstractFixtureController {
    static fixtures_dir_value = '';
    get fixtures_dir(): string { return TestFixtureController.fixtures_dir_value; }
    get fixture_types(): Record<string, FixtureTypeDefinition> {
        return {
            'tiny': { name: 'Tiny test fixture', est_seconds: 5 },
            'ts-only': {
                name: 'TS-only fixture',
                est_seconds: 10,
                creator: async () => ({ status: 0 }),
            },
        };
    }
}

function pick_port(): number {
    return 47900 + Math.floor(Math.random() * 200);
}

describe('AbstractFixtureController (integration)', () => {
    const port = pick_port();
    let server: FixtureServer;
    let fixtures_dir: string;

    beforeAll(async () => {
        fixtures_dir = mkdtempSync(join(tmpdir(), 'fixture-serve-ctrl-'));
        const script = join(fixtures_dir, 'create-fixture-tiny.sh');
        writeFileSync(script, '#!/bin/bash\necho tiny-done\n');
        chmodSync(script, 0o755);
        TestFixtureController.fixtures_dir_value = fixtures_dir;

        server = new FixtureServer({
            port,
            service_name: 'noop-*',
            health_url: `http://localhost:${port}/health`,
            mongo_uri: 'mongodb://localhost:27017',
            db_name: 'fixture_test',
            default_profile: 'small',
            controllers: [TestFixtureController],
            log_level: 'error',
            version: '9.9.9-test',
            name: 'fixture-controller-test',
        });
        await server.start();
        await new Promise(r => setTimeout(r, 100));
    }, 30000);

    afterAll(async () => {
        server?.stop();
    });

    it('GET /testfx/create-types returns fixture types from fixtures_dir and ts creators', async () => {
        const res = await fetch(`http://localhost:${port}/testfx/create-types`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body.ok).toBe(true);
        const ids = body.types.map((t: any) => t.id).sort();
        expect(ids).toContain('tiny');
        expect(ids).toContain('ts-only');
        const ts_only = body.types.find((t: any) => t.id === 'ts-only');
        expect(ts_only.has_ts_creator).toBe(true);
    });

    it('GET /testfx/provision-status returns idle when no provision active', async () => {
        const res = await fetch(`http://localhost:${port}/testfx/provision-status`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.status).toBe('idle');
    });

    it('POST /testfx/restore returns ok:false with error when fixture not in metadata', async () => {
        const res = await fetch(`http://localhost:${port}/testfx/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fixture_id: 'nonexistent-id' }),
        });
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/nonexistent-id/);
    });

    it('GET /testfx/readiness returns fixture server metadata', async () => {
        const res = await fetch(`http://localhost:${port}/testfx/readiness`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body).toHaveProperty('active_profile');
    });
});
