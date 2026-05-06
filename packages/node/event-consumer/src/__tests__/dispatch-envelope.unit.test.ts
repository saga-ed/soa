import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import type { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import type { EventEnvelope } from '@saga-ed/soa-event-envelope';
import { EventConsumer, type EventHandler } from '../consumer.js';

/**
 * Verifies the public dispatchEnvelope() entry point runs an envelope through
 * the same idempotency + tx pipeline as the broker path. Three behaviors are
 * load-bearing for downstream test helpers (e.g. MockPublisher in
 * ads-adm-api): handler runs inside a tx, duplicate envelopes skip the
 * handler, and handler errors trigger ROLLBACK.
 */

interface RecordedQuery {
    sql: string;
    params: ReadonlyArray<unknown>;
}

function makeFakeClient(insertRowCount: number): PoolClient & { queries: RecordedQuery[]; released: boolean } {
    const queries: RecordedQuery[] = [];
    let released = false;

    const client = {
        queries,
        get released() {
            return released;
        },
        async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
            queries.push({ sql, params });
            if (sql.includes('INSERT INTO consumed_events')) {
                return {
                    rowCount: insertRowCount,
                    rows: insertRowCount > 0 ? [{ event_id: params[1] }] : [],
                    command: 'INSERT',
                    oid: 0,
                    fields: [],
                } as unknown as QueryResult;
            }
            return {
                rowCount: 0,
                rows: [],
                command: 'OTHER',
                oid: 0,
                fields: [],
            } as unknown as QueryResult;
        },
        release() {
            released = true;
        },
    };

    return client as unknown as PoolClient & { queries: RecordedQuery[]; released: boolean };
}

function makeFakePool(client: PoolClient): Pool {
    return {
        async connect() {
            return client;
        },
    } as unknown as Pool;
}

const silentLogger: ILogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const stubConnectionManager: ConnectionManager =
    {} as unknown as ConnectionManager;

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
        eventId: '00000000-0000-4000-8000-000000000001',
        eventType: 'test.thing.upserted',
        eventVersion: 1,
        aggregateType: 'thing',
        aggregateId: 'thing-1',
        occurredAt: '2026-05-05T00:00:00.000Z',
        payload: { value: 42 },
        ...overrides,
    };
}

function makeHandler(): EventHandler<{ value: number }> & {
    invocations: Array<{ envelope: EventEnvelope; payload: { value: number } }>;
} {
    const invocations: Array<{
        envelope: EventEnvelope;
        payload: { value: number };
    }> = [];

    return {
        invocations,
        eventType: 'test.thing.upserted',
        eventVersion: 1,
        payloadSchema: z.object({ value: z.number() }),
        async handle(envelope, payload) {
            invocations.push({ envelope, payload });
        },
    };
}

describe('EventConsumer.dispatchEnvelope', () => {
    it('runs handler inside the same tx as the consumed_events insert', async () => {
        const client = makeFakeClient(1);
        const handler = makeHandler();

        const consumer = new EventConsumer({
            consumerName: 'test-consumer',
            pool: makeFakePool(client),
            connectionManager: stubConnectionManager,
            queue: 'test.queue',
            bindings: [],
            handlers: [handler],
            logger: silentLogger,
        });

        await consumer.dispatchEnvelope(makeEnvelope());

        const sqls = client.queries.map((q) => q.sql.trim().split(/\s+/)[0]);
        // BEGIN, INSERT, COMMIT — handler runs between INSERT and COMMIT.
        expect(sqls[0]).toBe('BEGIN');
        expect(client.queries[1]?.sql).toContain('INSERT INTO consumed_events');
        expect(sqls[sqls.length - 1]).toBe('COMMIT');
        expect(handler.invocations).toHaveLength(1);
        expect(handler.invocations[0]?.payload).toEqual({ value: 42 });
        expect(client.released).toBe(true);
    });

    it('skips the handler and calls onDuplicate when consumed_events insert returns 0 rows', async () => {
        const client = makeFakeClient(0); // ON CONFLICT DO NOTHING — duplicate
        const handler = makeHandler();
        const onDuplicate = vi.fn();

        const consumer = new EventConsumer({
            consumerName: 'test-consumer',
            pool: makeFakePool(client),
            connectionManager: stubConnectionManager,
            queue: 'test.queue',
            bindings: [],
            handlers: [handler],
            logger: silentLogger,
            metrics: {
                onProcessed: () => {},
                onFailed: () => {},
                onDuplicate,
            },
        });

        await consumer.dispatchEnvelope(makeEnvelope());

        expect(handler.invocations).toHaveLength(0);
        expect(onDuplicate).toHaveBeenCalledWith('test.thing.upserted', 1);
        // Even on duplicate path the tx must commit, not roll back.
        const sqls = client.queries.map((q) => q.sql.trim().split(/\s+/)[0]);
        expect(sqls).toContain('COMMIT');
        expect(sqls).not.toContain('ROLLBACK');
        expect(client.released).toBe(true);
    });

    it('issues ROLLBACK and rethrows when the handler throws', async () => {
        const client = makeFakeClient(1);
        const handlerError = new Error('handler boom');

        const throwingHandler: EventHandler<{ value: number }> = {
            eventType: 'test.thing.upserted',
            eventVersion: 1,
            payloadSchema: z.object({ value: z.number() }),
            async handle() {
                throw handlerError;
            },
        };

        const consumer = new EventConsumer({
            consumerName: 'test-consumer',
            pool: makeFakePool(client),
            connectionManager: stubConnectionManager,
            queue: 'test.queue',
            bindings: [],
            handlers: [throwingHandler],
            logger: silentLogger,
        });

        await expect(consumer.dispatchEnvelope(makeEnvelope())).rejects.toBe(
            handlerError,
        );

        const sqls = client.queries.map((q) => q.sql.trim().split(/\s+/)[0]);
        expect(sqls).toContain('ROLLBACK');
        expect(sqls).not.toContain('COMMIT');
        expect(client.released).toBe(true);
    });
});
