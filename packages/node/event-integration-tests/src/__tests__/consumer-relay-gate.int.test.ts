import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { Pool } from 'pg';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import { OUTBOX_EVENT_SQL, OutboxRelay, type OutboxRelayOpts } from '@saga-ed/soa-event-outbox';
import {
    CONSUMED_EVENTS_SQL,
    EventConsumer,
    type EventConsumerOpts,
} from '@saga-ed/soa-event-consumer';
import { makeConnectionManager, makeGate } from '../lib/amqp.js';
import { pollUntil } from '../lib/wait.js';

/**
 * D13 idle-colour gate against real Postgres + RabbitMQ: two EventConsumers
 * (same consumerName + queue, i.e. blue/green) and two OutboxRelays, each
 * with a controllable gate.
 */
const EXCHANGE = 'gate.events';
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

function message(eventId: string = randomUUID()) {
    return {
        eventId,
        body: Buffer.from(
            JSON.stringify({
                eventId,
                eventType: 'gate.thing',
                eventVersion: 1,
                aggregateType: 'thing',
                aggregateId: 'a1',
                occurredAt: new Date().toISOString(),
                payload: {},
            }),
        ),
    };
}

describe('consumer/relay activity gate (integration)', () => {
    let infra: InfraHandle;
    let dbUrl: string;
    let mq: ChannelModel;
    let pub: Channel;
    let pool: Pool;
    const cms: Array<{ close: () => Promise<void> }> = [];

    beforeAll(async () => {
        infra = await startInfra();
        dbUrl = await infra.createDatabase('gate_test');
        await infra.runSql(dbUrl, CONSUMED_EVENTS_SQL);
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        pool = new Pool({ connectionString: dbUrl, max: 12 });
        mq = await amqplib.connect(infra.rabbitmqUrl);
        pub = await mq.createChannel();
        await pub.assertExchange(EXCHANGE, 'topic', { durable: true });
    }, 120_000);

    afterAll(async () => {
        await pub?.close().catch(() => {});
        await mq?.close().catch(() => {});
        await Promise.all(cms.map((c) => c.close().catch(() => {})));
        await pool?.end();
        await infra?.stop();
    });

    function makeConsumer(
        side: string,
        queue: string,
        gate: ReturnType<typeof makeGate>,
        handled: Array<{ side: string; eventId: string }>,
        block?: () => Promise<void>,
    ) {
        const cm = makeConnectionManager(infra.rabbitmqUrl);
        cms.push(cm);
        const consumer = new EventConsumer({
            consumerName: `gate-test.${queue}`,
            pool,
            connectionManager: cm as unknown as EventConsumerOpts['connectionManager'],
            queue,
            bindings: [{ exchange: EXCHANGE, routingKey: 'gate.thing' }],
            handlers: [
                {
                    eventType: 'gate.thing',
                    eventVersion: 1,
                    payloadSchema: { parse: (v: unknown) => v } as never,
                    handle: async (envelope) => {
                        if (block) await block();
                        handled.push({ side, eventId: envelope.eventId });
                    },
                },
            ],
            logger: logger() as unknown as EventConsumerOpts['logger'],
            gate: gate.gate,
        });
        return consumer;
    }

    async function queueState(queue: string) {
        const ch = await mq.createChannel();
        try {
            const q = await ch.checkQueue(queue);
            return { consumers: q.consumerCount, messages: q.messageCount };
        } finally {
            await ch.close();
        }
    }

    it('exactly one colour consumes after a flip; nothing lost; dedup absorbs redelivery', async () => {
        const queue = `gate.flip.${Date.now()}`;
        const handled: Array<{ side: string; eventId: string }> = [];
        const blue = makeGate(true);
        const green = makeGate(false);
        const blueC = makeConsumer('blue', queue, blue, handled);
        const greenC = makeConsumer('green', queue, green, handled);
        await blueC.start();
        await greenC.start();

        // Idle colour asserts topology but holds no consumer.
        expect((await queueState(queue)).consumers).toBe(1);

        const before = Array.from({ length: 20 }, () => message());
        for (const m of before) pub.publish(EXCHANGE, 'gate.thing', m.body, { persistent: true });
        await pollUntil(async () => handled.length, (n) => n === 20);
        expect(new Set(handled.map((h) => h.side))).toEqual(new Set(['blue']));

        // Flip.
        blue.set(false);
        green.set(true);
        await pollUntil(
            async () => ({ b: blueC.getStatus().state, g: greenC.getStatus().state }),
            (s) => s.b === 'paused' && s.g === 'active',
        );
        await pollUntil(() => queueState(queue), (s) => s.consumers === 1);

        const after = Array.from({ length: 20 }, () => message());
        for (const m of after) pub.publish(EXCHANGE, 'gate.thing', m.body, { persistent: true });
        await pollUntil(async () => handled.length, (n) => n === 40);

        const afterIds = new Set(after.map((m) => m.eventId));
        const afterSides = handled.filter((h) => afterIds.has(h.eventId)).map((h) => h.side);
        expect(new Set(afterSides)).toEqual(new Set(['green']));
        expect(new Set(handled.map((h) => h.eventId)).size).toBe(40);

        // Redelivery of an already-processed event is absorbed by consumed_events.
        pub.publish(EXCHANGE, 'gate.thing', before[0]!.body, { persistent: true });
        await pollUntil(() => queueState(queue), (s) => s.messages === 0);
        await new Promise((r) => setTimeout(r, 300));
        expect(handled).toHaveLength(40);

        const rows = await pool.query(
            'SELECT count(*)::int AS n FROM consumed_events WHERE consumer_name = $1',
            [`gate-test.${queue}`],
        );
        expect(rows.rows[0].n).toBe(40);

        await blueC.stop();
        await greenC.stop();
    });

    it('pause() with a slow in-flight handler drains before it resolves; no loss', async () => {
        const queue = `gate.slow.${Date.now()}`;
        const handled: Array<{ side: string; eventId: string }> = [];
        let release!: () => void;
        const gateOpen = new Promise<void>((r) => (release = r));
        let started = 0;
        const consumer = makeConsumer(
            'slow',
            queue,
            makeGate(true),
            handled,
            async () => {
                started++;
                await gateOpen;
            },
        );
        await consumer.start();

        const m = message();
        pub.publish(EXCHANGE, 'gate.thing', m.body, { persistent: true });
        await pollUntil(async () => started, (n) => n === 1);

        let paused = false;
        const p = consumer.pause().then(() => {
            paused = true;
        });
        await pollUntil(() => queueState(queue), (s) => s.consumers === 0);
        expect(paused).toBe(false);
        expect(consumer.getStatus()).toMatchObject({ state: 'paused', inFlight: 1 });

        // Messages published while paused buffer in the durable queue.
        const m2 = message();
        pub.publish(EXCHANGE, 'gate.thing', m2.body, { persistent: true });
        await pollUntil(() => queueState(queue), (s) => s.messages === 1);

        release();
        await p;
        expect(handled.map((h) => h.eventId)).toEqual([m.eventId]);
        expect(consumer.getStatus().inFlight).toBe(0);

        await consumer.resume();
        await pollUntil(async () => handled.length, (n) => n === 2);
        expect(handled[1]!.eventId).toBe(m2.eventId);
        await consumer.stop();
    });

    it('relay leadership moves with the gate; each row published exactly once', async () => {
        const published = { a: 0, b: 0 };
        const mk = (side: 'a' | 'b', gate: ReturnType<typeof makeGate>) => {
            const cm = makeConnectionManager(infra.rabbitmqUrl);
            cms.push(cm);
            return new OutboxRelay({
                pool,
                connectionManager: cm as unknown as OutboxRelayOpts['connectionManager'],
                exchange: EXCHANGE,
                logger: logger() as unknown as OutboxRelayOpts['logger'],
                pollIntervalMs: 50,
                leaderPollIntervalMs: 100,
                gate: gate.gate,
                metrics: {
                    onPublished: () => {
                        published[side]++;
                    },
                    onPublishFailed: () => {},
                },
            });
        };
        const insert = async (): Promise<string> => {
            const id = randomUUID();
            await pool.query(
                `INSERT INTO outbox_event (event_id, aggregate_type, aggregate_id, event_type, event_version, payload, occurred_at)
                 VALUES ($1::uuid, 'thing', 'a1', 'relay.gate', 1, '{}'::jsonb, NOW())`,
                [id],
            );
            return id;
        };
        const unpublished = async () =>
            (await pool.query('SELECT count(*)::int AS n FROM outbox_event WHERE published_at IS NULL'))
                .rows[0].n as number;
        const advisoryHolders = async () =>
            (
                await pool.query(
                    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted",
                )
            ).rows[0].n as number;

        const ga = makeGate(true);
        const gb = makeGate(false);
        const a = mk('a', ga);
        const b = mk('b', gb);
        await a.start();
        await b.start();
        await pollUntil(async () => a.getStatus().state, (s) => s === 'leader');
        expect(b.getStatus().state).toBe('standby');

        for (let i = 0; i < 5; i++) await insert();
        await pollUntil(unpublished, (n) => n === 0);
        expect(published).toEqual({ a: 5, b: 0 });

        ga.set(false);
        gb.set(true);
        await pollUntil(
            async () => [a.getStatus().state, b.getStatus().state],
            ([sa, sb]) => sa === 'standby' && sb === 'leader',
            { timeoutMs: 15_000 },
        );
        expect(await advisoryHolders()).toBe(1);

        for (let i = 0; i < 5; i++) await insert();
        await pollUntil(unpublished, (n) => n === 0);
        expect(published).toEqual({ a: 5, b: 5 });

        await a.stop();
        await b.stop();
    });
});
