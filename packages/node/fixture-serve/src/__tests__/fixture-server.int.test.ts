import 'reflect-metadata';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Controller, Get } from 'routing-controllers';
import { injectable, inject } from 'inversify';
import type { ILogger } from '@saga-ed/soa-logger';
import { AbstractRestController } from '@saga-ed/soa-api-core';
import type { ExpressServerConfig } from '@saga-ed/soa-api-core';
import type { Request, Response } from 'express';

vi.mock('@saga-ed/infra-compose', () => ({
    get_active_profile: vi.fn(() => ({ profile: 'test-profile', switched_at: '2026-04-24T00:00:00Z' })),
}));

vi.mock('@saga-ed/infra-compose/router', async () => {
    const { Router } = await import('express');
    return {
        create_router: vi.fn(() => {
            const r = Router();
            r.get('/active-profile', (_req: Request, res: Response) => res.json({ ok: true, profile: 'test-profile' }));
            return r;
        }),
    };
});

import { FixtureServer } from '../server/fixture-server.js';

@injectable()
@Controller('/noop')
class NoopController extends AbstractRestController {
    readonly sectorName = 'noop';
    constructor(
        @inject('ILogger') logger: ILogger,
        @inject('ExpressServerConfig') serverConfig: ExpressServerConfig,
    ) {
        super(logger, 'noop', serverConfig);
    }
    @Get('/ping')
    ping() { return { pong: true }; }
}

function pick_port(): number {
    return 47700 + Math.floor(Math.random() * 200);
}

describe('FixtureServer (integration)', () => {
    const port = pick_port();
    let server: FixtureServer;

    beforeAll(async () => {
        server = new FixtureServer({
            port,
            service_name: 'noop-*',
            health_url: `http://localhost:${port}/health`,
            mongo_uri: 'mongodb://localhost:27017',
            db_name: 'fixture_test',
            default_profile: 'small',
            controllers: [NoopController],
            log_level: 'error',
            version: '9.9.9-test',
            name: 'fixture-server-test',
        });
        await server.start();
        await new Promise(r => setTimeout(r, 50));
    });

    afterAll(() => {
        server?.stop();
    });

    it('responds to /health with status, service name, version, active_profile', async () => {
        const res = await fetch(`http://localhost:${port}/health`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body).toMatchObject({
            status: 'ok',
            service: 'fixture-server-test',
            version: '9.9.9-test',
            port,
            active_profile: { profile: 'test-profile', switched_at: '2026-04-24T00:00:00Z' },
        });
    });

    it('mounts infra router at /infra', async () => {
        const res = await fetch(`http://localhost:${port}/infra/active-profile`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body).toEqual({ ok: true, profile: 'test-profile' });
    });

    it('routes registered controller endpoints', async () => {
        const res = await fetch(`http://localhost:${port}/noop/ping`);
        expect(res.ok).toBe(true);
        const body = await res.json();
        expect(body).toEqual({ pong: true });
    });

    it('exposes container via getContainer() with standard bindings', () => {
        const c = server.getContainer();
        expect(c.isBound('ILogger')).toBe(true);
        expect(c.isBound('ExpressServerConfig')).toBe(true);
        expect(c.isBound('FixtureControllerConfig')).toBe(true);
    });

    it('throws when neither controllers nor controller_glob is provided', async () => {
        const bad = new FixtureServer({
            port: pick_port(),
            service_name: 'x-*',
            health_url: 'http://localhost/health',
            mongo_uri: 'mongodb://localhost:27017',
            db_name: 'x',
            log_level: 'error',
        });
        await expect(bad.start()).rejects.toThrow(/either controllers or controller_glob/);
    });
});
