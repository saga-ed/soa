import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import { OutboxRelay, type EnvelopeTransform } from '../relay.js';

/**
 * Integration tests for the OutboxRelay transformEnvelope hook.
 *
 * Stubs Pool, Channel, ConnectionManager, and Logger — exercises the
 * publishRow path end-to-end to prove:
 *   1. transformEnvelope is called between database load and publish
 *   2. The returned envelope's bytes are what gets published to AMQP
 *   3. An async transform is awaited (not fire-and-forget)
 *   4. A transform that throws bumps `attempts` and isolates the
 *      failure to the offending row (poison-loop protection)
 *   5. With no transform supplied, behavior is identity (back-compat)
 *
 * These tests intentionally do NOT spin up a real Postgres or
 * RabbitMQ — the hook contract is what we're verifying, not the broker
 * or DB clients.
 */

interface StubChannelPublishCall {
    exchange: string;
    routingKey: string;
    payload: Buffer;
}

function makeStubChannel() {
    const calls: StubChannelPublishCall[] = [];
    const channel = {
        assertExchange: vi.fn(async () => undefined),
        publish: vi.fn(
            (exchange: string, routingKey: string, payload: Buffer) => {
                calls.push({ exchange, routingKey, payload });
                return true;
            },
        ),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
        close: vi.fn(async () => undefined),
    };
    return { channel, calls };
}

function makeStubLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    };
}

interface PoolQueryCall {
    sql: string;
    params: unknown[];
}

function makeStubPool(rows: Record<string, unknown>[]) {
    const queries: PoolQueryCall[] = [];
    let consumed = false;
    const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
            queries.push({ sql, params: params ?? [] });
            // First SELECT returns the rows; second-and-later return empty
            if (sql.includes('SELECT') && !consumed) {
                consumed = true;
                return { rows };
            }
            return { rows: [] };
        }),
        release: vi.fn(),
    };
    const pool = {
        connect: vi.fn(async () => client),
    };
    return { pool, client, queries };
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        event_id: '00000000-0000-4000-8000-000000000001',
        aggregate_type: 'user',
        aggregate_id: 'u-1',
        event_type: 'identity.user.created',
        event_version: 1,
        payload: { userId: 'u-1' },
        meta: null,
        occurred_at: new Date('2026-05-07T00:00:00.000Z'),
        attempts: 0,
        ...overrides,
    };
}

async function buildRelay(opts: {
    rows?: Record<string, unknown>[];
    transformEnvelope?: EnvelopeTransform;
    maxAttempts?: number;
}) {
    const { channel, calls } = makeStubChannel();
    const { pool, queries } = makeStubPool(opts.rows ?? []);
    const logger = makeStubLogger();
    const connectionManager = {
        newChannel: vi.fn(async () => channel),
    };
    const relay = new OutboxRelay({
        pool: pool as never,
        connectionManager: connectionManager as never,
        exchange: 'test.events',
        logger: logger as never,
        transformEnvelope: opts.transformEnvelope,
        maxAttempts: opts.maxAttempts,
    });
    await relay.start();
    return { relay, channel, publishCalls: calls, queries, logger };
}

function readPublishedEnvelope(payload: Buffer): EventEnvelope {
    return JSON.parse(payload.toString('utf8')) as EventEnvelope;
}

describe('OutboxRelay transformEnvelope hook', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('publishes identity envelope when no transform is supplied', async () => {
        const { relay, publishCalls } = await buildRelay({
            rows: [makeRow()],
        });
        // Manually drive one batch (the start() polling loop is async; we
        // don't want to wait for it). drainBatch is private, but tick is
        // package-internal — call it via the public scheduleNext path.
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();
        expect(publishCalls).toHaveLength(1);
        const env = readPublishedEnvelope(publishCalls[0]!.payload);
        expect(env.eventType).toBe('identity.user.created');
        expect(env.meta?.signature).toBeUndefined();
        await relay.stop();
    });

    it('calls transformEnvelope with the wire-meta-enriched envelope', async () => {
        const seen: EventEnvelope[] = [];
        const transform: EnvelopeTransform = (env) => {
            seen.push(env);
            return env;
        };
        const { relay } = await buildRelay({
            rows: [makeRow()],
            transformEnvelope: transform,
        });
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();
        expect(seen).toHaveLength(1);
        expect(seen[0]!.eventId).toBe('00000000-0000-4000-8000-000000000001');
        await relay.stop();
    });

    it('publishes the envelope returned by transformEnvelope (not the input)', async () => {
        const transform: EnvelopeTransform = (env) => ({
            ...env,
            meta: {
                ...env.meta,
                signature: { alg: 'HS256', keyId: 'k1', value: 'A'.repeat(43) },
            } as EventEnvelope['meta'],
        });
        const { relay, publishCalls } = await buildRelay({
            rows: [makeRow()],
            transformEnvelope: transform,
        });
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();
        const env = readPublishedEnvelope(publishCalls[0]!.payload);
        expect(env.meta?.signature).toEqual({
            alg: 'HS256',
            keyId: 'k1',
            value: 'A'.repeat(43),
        });
        await relay.stop();
    });

    it('awaits async transformEnvelope before publishing', async () => {
        let resolved = false;
        const transform: EnvelopeTransform = async (env) => {
            await new Promise<void>((r) => setTimeout(r, 10));
            resolved = true;
            return env;
        };
        const { relay, publishCalls } = await buildRelay({
            rows: [makeRow()],
            transformEnvelope: transform,
        });
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();
        expect(resolved).toBe(true);
        expect(publishCalls).toHaveLength(1);
        await relay.stop();
    });

    it('isolates a failing transform to the offending row, bumps attempts, continues batch', async () => {
        const goodRow = makeRow({
            event_id: '00000000-0000-4000-8000-000000000001',
        });
        const badRow = makeRow({
            event_id: '00000000-0000-4000-8000-000000000002',
            event_type: 'identity.user.broken',
        });
        const transform: EnvelopeTransform = (env) => {
            if (env.eventType === 'identity.user.broken') {
                throw new Error('signing failed for this event');
            }
            return env;
        };
        const { relay, publishCalls, queries, logger } = await buildRelay({
            rows: [goodRow, badRow],
            transformEnvelope: transform,
        });
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();

        // Good row published; bad row not
        expect(publishCalls).toHaveLength(1);
        expect(readPublishedEnvelope(publishCalls[0]!.payload).eventType).toBe(
            'identity.user.created',
        );

        // attempts++ UPDATE for the failed row
        const attemptsUpdate = queries.find((q) =>
            q.sql.includes('attempts = attempts + 1'),
        );
        expect(attemptsUpdate).toBeDefined();
        expect(attemptsUpdate!.params[0]).toEqual([badRow.event_id]);

        // published_at UPDATE for the good row only
        const publishedUpdate = queries.find((q) =>
            q.sql.includes('SET published_at = NOW()'),
        );
        expect(publishedUpdate).toBeDefined();
        expect(publishedUpdate!.params[0]).toEqual([goodRow.event_id]);

        // Warning logged for the failure
        expect(logger.warn).toHaveBeenCalled();
        await relay.stop();
    });

    it('skips rows whose attempts >= maxAttempts (poison-loop protection)', async () => {
        const { relay, queries } = await buildRelay({
            rows: [],
            maxAttempts: 5,
        });
        await (relay as unknown as { drainBatch: () => Promise<void> }).drainBatch();
        const select = queries.find((q) => q.sql.includes('SELECT'));
        expect(select).toBeDefined();
        expect(select!.sql).toContain('attempts < $2');
        expect(select!.params[1]).toBe(5);
        await relay.stop();
    });
});
