import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { ILogger } from '@saga-ed/soa-logger';
import {
    inspectDeadLetterQueue,
    replayDeadLetters,
    type DlqChannel,
} from '../dlq-replay-runner.js';

/**
 * The same paths as the unit tests, but against a real RabbitMQ — because the
 * parts most likely to be wrong are the ones a fake cannot get wrong: whether
 * `basic.get` really walks past messages it is holding unacked, what the broker
 * actually writes into `x-death`, whether a publish to the default exchange
 * really lands on exactly one queue, and whether the DLQ really is unchanged
 * afterwards.
 *
 * It also type-checks `amqplib`'s ConfirmChannel against the structural
 * `DlqChannel` the module declares — see `asDlqChannel` below.
 *
 *   pnpm --filter @saga-ed/soa-event-consumer test:int
 *
 * Point RABBITMQ_TEST_URL at a broker, or start a throwaway one:
 *   docker run -d --rm --name dlq-replay-rabbit -p 45672:5672 rabbitmq:3-management
 */

const BROKER_URL = process.env.RABBITMQ_TEST_URL ?? 'amqp://guest:guest@localhost:45672';
const logger: ILogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Compile-time proof that a real ConfirmChannel satisfies the structural
 * interface. If amqplib's shape ever drifts from what the runner declares, this
 * fails to type-check rather than failing mysteriously at runtime in prod.
 */
function asDlqChannel(channel: ConfirmChannel): DlqChannel {
    return channel;
}

const suffix = randomUUID().slice(0, 8);
const TARGET_QUEUE = `dlq-replay-test.target.${suffix}`;
const OTHER_QUEUE = `dlq-replay-test.other.${suffix}`;
const DLX = `dlq-replay-test.dlx.${suffix}`;
const DLQ = `dlq-replay-test.dlq.${suffix}`;
/** The type the imaginary wiring service has allowlisted as safe to re-run. */
const REPLAYABLE_TYPE = 'iam.persona_assignment.added';

let connection: ChannelModel | null = null;
let available = false;

function source() {
    return {
        async newConfirmChannel(): Promise<DlqChannel> {
            if (!connection) throw new Error('no broker connection');
            return asDlqChannel(await connection.createConfirmChannel());
        },
    };
}

function envelope(eventType: string, aggregateId: string): Buffer {
    return Buffer.from(
        JSON.stringify({
            eventId: randomUUID(),
            eventType,
            eventVersion: 1,
            aggregateType: 'persona_assignment',
            aggregateId,
            occurredAt: new Date().toISOString(),
            payload: { id: aggregateId },
        }),
    );
}

/**
 * Put messages on a queue and reject them, so RabbitMQ dead-letters them for
 * real. Nothing here fabricates an `x-death` header — the point is to read what
 * the broker itself writes.
 */
async function deadLetter(
    sourceQueue: string,
    messages: ReadonlyArray<{ routingKey: string; content: Buffer }>,
): Promise<void> {
    if (!connection) throw new Error('no broker connection');
    const channel = await connection.createConfirmChannel();
    for (const message of messages) {
        channel.publish('', sourceQueue, message.content, {
            persistent: true,
            type: message.routingKey,
        });
    }
    await channel.waitForConfirms();

    for (let i = 0; i < messages.length; i++) {
        const got = await channel.get(sourceQueue, { noAck: false });
        if (got === false) throw new Error(`expected ${messages.length} messages on ${sourceQueue}`);
        // requeue=false is what routes it to the queue's dead-letter exchange.
        channel.nack(got, false, false);
    }
    await channel.close();
}

beforeAll(async () => {
    try {
        connection = await connect(BROKER_URL, { heartbeat: 10 });
    } catch {
        available = false;
        return;
    }
    available = true;

    const setup = await connection.createChannel();
    await setup.assertExchange(DLX, 'topic', { durable: false, autoDelete: false });
    await setup.assertQueue(DLQ, { durable: false });
    await setup.bindQueue(DLQ, DLX, '#');
    // Two queues that dead-letter into the SAME DLQ — the shared-DLQ case the
    // first-death-queue guard exists for.
    for (const queue of [TARGET_QUEUE, OTHER_QUEUE]) {
        await setup.assertQueue(queue, {
            durable: false,
            arguments: { 'x-dead-letter-exchange': DLX },
        });
    }
    await setup.close();

    await deadLetter(TARGET_QUEUE, [
        { routingKey: REPLAYABLE_TYPE, content: envelope(REPLAYABLE_TYPE, 'agg-1') },
        { routingKey: REPLAYABLE_TYPE, content: envelope(REPLAYABLE_TYPE, 'agg-2') },
        { routingKey: 'iam.persona_definition.upserted', content: envelope('iam.persona_definition.upserted', 'persona-1') },
    ]);
    await deadLetter(OTHER_QUEUE, [
        { routingKey: REPLAYABLE_TYPE, content: envelope(REPLAYABLE_TYPE, 'agg-other') },
    ]);
});

afterAll(async () => {
    if (!connection) return;
    try {
        const teardown = await connection.createChannel();
        for (const queue of [TARGET_QUEUE, OTHER_QUEUE, DLQ]) {
            await teardown.deleteQueue(queue).catch(() => {});
        }
        await teardown.deleteExchange(DLX).catch(() => {});
        await teardown.close();
    } finally {
        await connection.close();
    }
});

describe.runIf(process.env.RABBITMQ_TEST_URL !== 'skip')('dead-letter replay against a real broker', () => {
    it('is running against a broker', () => {
        expect(
            available,
            `No broker at ${BROKER_URL}. Start one: docker run -d --rm --name dlq-replay-rabbit -p 45672:5672 rabbitmq:3-management`,
        ).toBe(true);
    });

    it('inspects the queue and leaves every message on it', async () => {
        const first = await inspectDeadLetterQueue({
            connectionManager: source(),
            dlqQueue: DLQ,
            logger,
        });

        expect(first.queueDepth).toBe(4);
        expect(first.messages).toHaveLength(4);
        // The broker's own x-death told us where each one died.
        expect(first.messages.filter(m => m.firstDeathQueue === TARGET_QUEUE)).toHaveLength(3);
        expect(first.messages.filter(m => m.firstDeathQueue === OTHER_QUEUE)).toHaveLength(1);
        expect(first.messages.every(m => m.firstDeathReason === 'rejected')).toBe(true);
        expect(first.messages.every(m => m.deadLetteredAt instanceof Date)).toBe(true);
        expect(first.messages.every(m => m.eventId !== null)).toBe(true);
        expect(first.groups.reduce((sum, g) => sum + g.count, 0)).toBe(4);

        // Read-only: a second pass sees exactly the same queue.
        const second = await inspectDeadLetterQueue({
            connectionManager: source(),
            dlqQueue: DLQ,
            logger,
        });
        expect(second.queueDepth).toBe(4);
        expect(new Set(second.messages.map(m => m.eventId))).toEqual(
            new Set(first.messages.map(m => m.eventId)),
        );
    });

    it('replays only the targeted messages, to only the target queue, keeping the originals', async () => {
        const dryRun = await replayDeadLetters({
            connectionManager: source(),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: [REPLAYABLE_TYPE] },
            logger,
        });

        // 2 of the 4: the third on the target queue is a different event type,
        // and the fourth died on the other service's queue.
        expect(dryRun.selection.selected).toHaveLength(2);
        expect(dryRun.replayed).toEqual([]);
        expect(dryRun.selection.decisions.map(d => d.reason).filter(Boolean).sort()).toEqual([
            'event-type-not-allowed',
            'not-target-queue',
        ]);

        const replay = await replayDeadLetters({
            connectionManager: source(),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: [REPLAYABLE_TYPE] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });
        expect(replay.failure).toBeNull();
        expect(replay.replayed).toHaveLength(2);

        if (!connection) throw new Error('no broker connection');
        const check = await connection.createChannel();
        // The DLQ still holds all four originals — nothing was acked.
        expect((await check.checkQueue(DLQ)).messageCount).toBe(4);
        // Exactly the two copies landed on the target queue…
        expect((await check.checkQueue(TARGET_QUEUE)).messageCount).toBe(2);
        // …and nothing reached the other consumer's queue.
        expect((await check.checkQueue(OTHER_QUEUE)).messageCount).toBe(0);

        const replayedIds = new Set(replay.replayed.map(m => m.eventId));
        for (let i = 0; i < 2; i++) {
            const got = await check.get(TARGET_QUEUE, { noAck: true });
            if (got === false) throw new Error('expected a replayed copy');
            const body = JSON.parse(got.content.toString()) as { eventId: string };
            expect(replayedIds.has(body.eventId)).toBe(true);
            // Stamped with where it came from, and stripped of the old death chain
            // so a second failure records a fresh death naming the target queue.
            expect(got.properties.headers?.['x-saga-replayed-from']).toBe(DLQ);
            expect(got.properties.headers?.['x-death']).toBeUndefined();
            expect(got.properties.headers?.['x-first-death-queue']).toBeUndefined();
            // RabbitMQ 3.13 also writes x-last-death-*; a real broker is the
            // only place that shows up, which is why it is asserted here too.
            expect(got.properties.headers?.['x-last-death-queue']).toBeUndefined();
            expect(got.properties.headers?.['x-last-death-reason']).toBeUndefined();
        }
        await check.close();
    });

    it('refuses an approve whose confirmation was minted against a different filter', async () => {
        const dryRun = await replayDeadLetters({
            connectionManager: source(),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: [REPLAYABLE_TYPE] },
            logger,
        });

        await expect(
            replayDeadLetters({
                connectionManager: source(),
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                // Same confirmation, wider filter — refused.
                filter: {
                    eventTypes: [REPLAYABLE_TYPE, 'iam.persona_definition.upserted'],
                },
                approve: true,
                confirm: dryRun.selection.confirmation,
                logger,
            }),
        ).rejects.toThrow(/does not describe what this run selected/);

        if (!connection) throw new Error('no broker connection');
        const check = await connection.createChannel();
        expect((await check.checkQueue(DLQ)).messageCount).toBe(4);
        await check.close();
    });

    it('replays a scan it could only see part of, when --event-id names what it found', async () => {
        // The incident shape, against a real broker: a dead-letter queue too
        // deep to take in whole, and an operator who knows exactly which event
        // ids they want. The selection is the list they typed, so it is the
        // same from any part of the queue — which the assertions below check by
        // approving against a SECOND scan, of a queue the first one requeued.
        // Smaller than the queue, so every run sees only part of it. Without
        // the event-id rule no approve here could ever be confirmed.
        const SCAN_LIMIT = 3;
        // Take the ids out of a scan of the same size, so this test asserts the
        // rule rather than a guess about which part the broker hands back.
        const window = await inspectDeadLetterQueue({
            connectionManager: source(),
            dlqQueue: DLQ,
            scanLimit: SCAN_LIMIT,
            logger,
        });
        expect(window.scanTruncated).toBe(true);
        const wanted = window.messages
            .filter(m => m.firstDeathQueue === TARGET_QUEUE && m.eventType === REPLAYABLE_TYPE)
            .map(m => m.eventId as string);
        expect(wanted.length).toBeGreaterThan(0);

        const dryRun = await replayDeadLetters({
            connectionManager: source(),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventIds: wanted },
            scanLimit: SCAN_LIMIT,
            logger,
        });
        expect(dryRun.inspection.scanTruncated).toBe(true);
        expect(dryRun.selection.namedIdCoverage.complete).toBe(true);

        const replay = await replayDeadLetters({
            connectionManager: source(),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventIds: wanted },
            scanLimit: SCAN_LIMIT,
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });
        expect(replay.failure).toBeNull();
        // Sorted for comparison: the replay order is by death time, and these
        // all died inside the same second.
        expect(replay.replayed.map(m => m.eventId).sort()).toEqual([...wanted].sort());

        if (!connection) throw new Error('no broker connection');
        const check = await connection.createChannel();
        // The originals are all still there, and only the two copies landed.
        expect((await check.checkQueue(DLQ)).messageCount).toBe(4);
        expect((await check.checkQueue(TARGET_QUEUE)).messageCount).toBe(2);
        await check.purgeQueue(TARGET_QUEUE);
        await check.close();
    });

    it('refuses to replay into a queue that does not exist', async () => {
        await expect(
            replayDeadLetters({
                connectionManager: source(),
                dlqQueue: DLQ,
                targetQueue: `${TARGET_QUEUE}.typo`,
                filter: { eventTypes: [REPLAYABLE_TYPE] },
                logger,
            }),
        ).rejects.toThrow(/NOT_FOUND|no queue/i);
    });
});
