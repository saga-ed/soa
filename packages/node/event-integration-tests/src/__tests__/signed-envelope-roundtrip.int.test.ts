import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { Pool } from 'pg';
import {
    OUTBOX_EVENT_SQL,
    OutboxRelay,
} from '@saga-ed/soa-event-outbox';
import {
    signEnvelope,
    verifyEnvelope,
    type EventEnvelope,
} from '@saga-ed/soa-event-envelope';
import { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import {
    startInfra,
    type InfraHandle,
} from '@saga-ed/soa-event-test-harness';

const KEY_ID = 'test-signing-key-1';
const SECRET = Buffer.from(
    'a'.repeat(32) + 'b'.repeat(32),
    'utf8',
);
const EXCHANGE = 'identity.events.signing.test';

interface PublishedMessage extends EventEnvelope {
    meta?: EventEnvelope['meta'];
}

const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

/**
 * Real round-trip of the ADR 0003 signing seam:
 *   1. Insert an outbox row with no signature.
 *   2. Run the relay with `transformEnvelope: signEnvelope(...)`.
 *   3. A sniffer queue captures the published wire bytes.
 *   4. Verify the sniffed envelope under the same key (positive case),
 *      under a wrong key (unknown_key), and after a value tamper (invalid).
 *
 * If any of these fail, the producer-side seam is broken end to end —
 * something unit tests on `signEnvelope` alone cannot catch (e.g. a relay
 * regression that bypasses the transform, or a JSON-stringify drift between
 * sign-time and consumer-time bytes).
 */
describe('signed envelope round-trip (integration)', () => {
    let infra: InfraHandle;
    let pool: Pool;
    let connMgr: ConnectionManager;
    let relay: OutboxRelay;
    let mqConn: ChannelModel;
    let snifferChannel: Channel;
    const sniffQueue = `test.signed-sniffer.${Date.now()}`;

    beforeAll(async () => {
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('signed_envelope_test');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        pool = new Pool({ connectionString: dbUrl });

        connMgr = new ConnectionManager(noopLogger, { url: infra.rabbitmqUrl });
        await connMgr.connect();

        relay = new OutboxRelay({
            pool,
            connectionManager: connMgr,
            exchange: EXCHANGE,
            pollIntervalMs: 100,
            logger: noopLogger,
            transformEnvelope: (env) =>
                signEnvelope(env, { keyId: KEY_ID, secret: SECRET }),
        });
        await relay.start();

        mqConn = await amqplib.connect(infra.rabbitmqUrl);
        snifferChannel = await mqConn.createChannel();
        await snifferChannel.assertExchange(EXCHANGE, 'topic', {
            durable: true,
        });
        await snifferChannel.assertQueue(sniffQueue, {
            durable: false,
            autoDelete: true,
            exclusive: true,
        });
        await snifferChannel.bindQueue(sniffQueue, EXCHANGE, '#');
    }, 120_000);

    afterAll(async () => {
        try {
            await relay?.stop();
        } catch {}
        try {
            await snifferChannel?.close();
            await mqConn?.close();
        } catch {}
        try {
            await pool?.end();
        } catch {}
        await infra?.stop();
    });

    it('relay signs unsigned outbox rows and consumer verifies under the same key', async () => {
        const eventId = newUuid();
        await pool.query(
            `INSERT INTO outbox_event (
                event_id, aggregate_type, aggregate_id, event_type,
                event_version, payload, occurred_at
             ) VALUES ($1::uuid, 'user', $2, 'identity.user.created',
                       1, $3::jsonb, NOW())`,
            [
                eventId,
                'sign-pos-' + Date.now(),
                JSON.stringify({
                    userId: 'sign-pos',
                    name: 'Sign Positive',
                    email: 'sign-pos@example.com',
                }),
            ],
        );

        const msg = await waitForMessage(
            snifferChannel,
            sniffQueue,
            (m) => m.eventId === eventId,
            5_000,
        );
        expect(msg.meta?.signature).toBeDefined();
        expect(msg.meta!.signature!.alg).toBe('HS256');
        expect(msg.meta!.signature!.keyId).toBe(KEY_ID);
        expect(msg.meta!.signature!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const result = await verifyEnvelope(msg, async (kid) =>
            kid === KEY_ID ? SECRET : null,
        );
        expect(result.status).toBe('valid');
        expect(result.ok).toBe(true);

        // Outbox row must be marked published after the relay tick.
        const r = await pool.query<{ published_at: Date | null }>(
            `SELECT published_at FROM outbox_event WHERE event_id = $1::uuid`,
            [eventId],
        );
        expect(r.rows[0]?.published_at).not.toBeNull();
    });

    it('verification with an unknown key returns unknown_key', async () => {
        const eventId = newUuid();
        await pool.query(
            `INSERT INTO outbox_event (
                event_id, aggregate_type, aggregate_id, event_type,
                event_version, payload, occurred_at
             ) VALUES ($1::uuid, 'user', $2, 'identity.user.created',
                       1, $3::jsonb, NOW())`,
            [
                eventId,
                'sign-unk-' + Date.now(),
                JSON.stringify({ userId: 'sign-unk' }),
            ],
        );
        const msg = await waitForMessage(
            snifferChannel,
            sniffQueue,
            (m) => m.eventId === eventId,
            5_000,
        );
        const result = await verifyEnvelope(msg, async () => null);
        expect(result.status).toBe('unknown_key');
        expect(result.ok).toBe(false);
        expect(result.keyId).toBe(KEY_ID);
    });

    it('a tampered payload byte invalidates the signature', async () => {
        const eventId = newUuid();
        await pool.query(
            `INSERT INTO outbox_event (
                event_id, aggregate_type, aggregate_id, event_type,
                event_version, payload, occurred_at
             ) VALUES ($1::uuid, 'user', $2, 'identity.user.created',
                       1, $3::jsonb, NOW())`,
            [
                eventId,
                'sign-tamper-' + Date.now(),
                JSON.stringify({ userId: 'sign-tamper', name: 'Original' }),
            ],
        );
        const msg = await waitForMessage(
            snifferChannel,
            sniffQueue,
            (m) => m.eventId === eventId,
            5_000,
        );
        // Tamper the payload AFTER capture; signature is over the original
        // canonical bytes, so re-verify must fail under the same key.
        const tampered: EventEnvelope = {
            ...msg,
            payload: { ...msg.payload, name: 'Tampered' },
        };
        const result = await verifyEnvelope(tampered, async () => SECRET);
        expect(result.status).toBe('invalid');
        expect(result.ok).toBe(false);
    });
});

function newUuid(): string {
    return (
        '00000000-0000-4000-8000-' +
        Math.floor(Math.random() * 0xffffffffffff)
            .toString(16)
            .padStart(12, '0')
    );
}

async function waitForMessage(
    channel: Channel,
    queue: string,
    predicate: (m: PublishedMessage) => boolean,
    timeoutMs: number,
): Promise<PublishedMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const got = await channel.get(queue, { noAck: true });
        if (got) {
            const msg = JSON.parse(
                got.content.toString('utf8'),
            ) as PublishedMessage;
            if (predicate(msg)) return msg;
        } else {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for matching message`);
}
