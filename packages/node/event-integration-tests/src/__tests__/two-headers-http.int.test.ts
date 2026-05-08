import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import {
    decideTwoHeaders,
    HEADER_AUTHORIZATION,
    HEADER_SAGA_CALLER,
    type TwoHeadersDecision,
    type TwoHeadersMode,
} from '@saga-ed/soa-auth-contracts';

/**
 * Real HTTP round-trip of the ADR 0002 two-headers seam:
 *
 *   client → fetch with various header combinations →
 *   http.createServer → decideTwoHeaders(req.headers, mode) →
 *   200 (allow / log) | 401 (reject)
 *
 * Validates against `IncomingMessage.headers` — the same shape
 * Express-based services (rostering iam-api, programs-api) hand to the
 * package — which lowercases header names and may produce string[] for
 * repeated headers. Unit tests on `parseTwoHeaders` exercise the helper
 * directly; this test exercises the *wire path* end to end.
 */
describe('two-headers HTTP round-trip (integration)', () => {
    let server: Server;
    let baseUrl: string;
    let mode: TwoHeadersMode = 'shadow';
    const decisions: Array<{ path: string; decision: TwoHeadersDecision }> = [];

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
        const decision = decideTwoHeaders(
            req.headers as Record<string, string | string[] | undefined>,
            mode,
        );
        decisions.push({ path: req.url ?? '', decision });
        if (decision.action === 'reject') {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    error: 'unauthorized',
                    reason: decision.metricReason,
                }),
            );
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                ok: true,
                action: decision.action,
                metricReason: decision.metricReason ?? null,
                callerSpiffeId: decision.parse.callerSpiffeId,
            }),
        );
    };

    beforeAll(async () => {
        server = createServer(handler);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) =>
            server.close((err) => (err ? reject(err) : resolve())),
        );
    });

    function setMode(m: TwoHeadersMode): void {
        mode = m;
        decisions.length = 0;
    }

    describe('shadow mode', () => {
        beforeAll(() => setMode('shadow'));

        it('complete + valid headers → allow, no metric', async () => {
            const r = await fetch(`${baseUrl}/ok`, {
                headers: {
                    [HEADER_SAGA_CALLER]: 'spiffe://saga.dev/test-client',
                    [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt',
                },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.action).toBe('allow');
            expect(body.metricReason).toBeNull();
            expect(body.callerSpiffeId).toBe('spiffe://saga.dev/test-client');
        });

        it('missing X-Saga-Caller → log, status 200, metric=caller_missing', async () => {
            const r = await fetch(`${baseUrl}/no-caller`, {
                headers: { [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt' },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.action).toBe('log');
            expect(body.metricReason).toBe('caller_missing');
        });

        it('malformed X-Saga-Caller → log, metric=caller_malformed', async () => {
            const r = await fetch(`${baseUrl}/bad-caller`, {
                headers: {
                    [HEADER_SAGA_CALLER]: 'not-a-spiffe-id',
                    [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt',
                },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.metricReason).toBe('caller_malformed');
        });

        it('missing Authorization → log, metric=subject_missing', async () => {
            const r = await fetch(`${baseUrl}/no-auth`, {
                headers: { [HEADER_SAGA_CALLER]: 'spiffe://saga.dev/test-client' },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.metricReason).toBe('subject_missing');
        });

        it('non-Bearer Authorization → log, metric=subject_malformed', async () => {
            const r = await fetch(`${baseUrl}/bad-auth`, {
                headers: {
                    [HEADER_SAGA_CALLER]: 'spiffe://saga.dev/test-client',
                    [HEADER_AUTHORIZATION]: 'Basic dXNlcjpwYXNz',
                },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.metricReason).toBe('subject_malformed');
        });

        it('lowercase X-Saga-Caller (Node-normalized) is honored', async () => {
            // Express passes `req.headers` already lowercased — the parser must
            // tolerate that without a case-sensitive miss.
            const r = await fetch(`${baseUrl}/lowercase`, {
                headers: {
                    'x-saga-caller': 'spiffe://saga.dev/test-client',
                    authorization: 'Bearer eyJ.fake.jwt',
                },
            });
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.action).toBe('allow');
            expect(body.callerSpiffeId).toBe('spiffe://saga.dev/test-client');
        });
    });

    describe('enforce mode', () => {
        beforeAll(() => setMode('enforce'));

        it('complete headers → 200', async () => {
            const r = await fetch(`${baseUrl}/ok`, {
                headers: {
                    [HEADER_SAGA_CALLER]: 'spiffe://saga.dev/test-client',
                    [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt',
                },
            });
            expect(r.status).toBe(200);
        });

        it('missing X-Saga-Caller → 401 with reason', async () => {
            const r = await fetch(`${baseUrl}/reject`, {
                headers: { [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt' },
            });
            expect(r.status).toBe(401);
            const body = await r.json();
            expect(body.reason).toBe('caller_missing');
        });

        it('malformed caller → 401 with reason', async () => {
            const r = await fetch(`${baseUrl}/reject`, {
                headers: {
                    [HEADER_SAGA_CALLER]: 'http://not-spiffe',
                    [HEADER_AUTHORIZATION]: 'Bearer eyJ.fake.jwt',
                },
            });
            expect(r.status).toBe(401);
            const body = await r.json();
            expect(body.reason).toBe('caller_malformed');
        });
    });

    describe('off mode', () => {
        beforeAll(() => setMode('off'));

        it('totally absent headers → 200, no metric', async () => {
            const r = await fetch(`${baseUrl}/off`);
            expect(r.status).toBe(200);
            const body = await r.json();
            expect(body.action).toBe('allow');
            expect(body.metricReason).toBeNull();
        });
    });
});
