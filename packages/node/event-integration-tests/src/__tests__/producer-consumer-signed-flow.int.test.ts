import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { Pool } from 'pg';
import {
    OUTBOX_EVENT_SQL,
    OutboxRelay,
} from '@saga-ed/soa-event-outbox';
import {
    decideSignature,
    signEnvelope,
    type EventEnvelope,
    type SignatureKeyResolver,
    type SignatureMode,
} from '@saga-ed/soa-event-envelope';
import { ConnectionManager } from '@saga-ed/soa-rabbitmq';
import {
    startInfra,
    type InfraHandle,
} from '@saga-ed/soa-event-test-harness';

/**
 * Full producer↔consumer signed-event flow per the rollout plan.
 *
 * Mirrors the real env-var plumbing both apps use:
 *   producer (rostering iam-api):
 *     EVENT_SIGNING_KEY_ID, EVENT_SIGNING_SECRET → OutboxRelay's
 *     transformEnvelope hook calls signEnvelope(env, {keyId, secret}).
 *   consumer (program-hub programs-api):
 *     EVENT_SIGNATURE_VERIFY_KEYS (JSON map keyId→secret),
 *     EVENT_SIGNATURE_ENFORCE flag → decideSignature(env, resolveKey, mode).
 *
 * Confidence target: prove that the *real services' configuration paths*
 * agree on canonical bytes. The two sides import the same code from
 * @saga-ed/soa-event-envelope, but a config typo (case-sensitive keyId,
 * different base64 alphabet, different secret encoding) would silently
 * break only when both sides actually run. This test guards that gap.
 */

const EXCHANGE = 'identity.events.flow.test';
const KEY_ID_V1 = 'key-v1';
const KEY_ID_V2 = 'key-v2';
const SECRET_V1 = 'a'.repeat(64);
const SECRET_V2 = 'b'.repeat(64);

const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

interface ConsumedSignal {
    envelope: EventEnvelope;
    decision: Awaited<ReturnType<typeof decideSignature>>;
    accepted: boolean;
}

/**
 * Replicates rostering inversify.config.ts shape.
 * See apps/node/iam-api/src/inversify.config.ts:73-90.
 */
function buildProducerTransform(): ((env: EventEnvelope) => EventEnvelope) | undefined {
    const id = (process.env.EVENT_SIGNING_KEY_ID ?? '').trim();
    const secret = (process.env.EVENT_SIGNING_SECRET ?? '').trim();
    if (!id && !secret) return undefined;
    if (!id || !secret) {
        throw new Error(
            'EVENT_SIGNING_KEY_ID and EVENT_SIGNING_SECRET must both be set or both unset',
        );
    }
    return (envelope) => signEnvelope(envelope, { keyId: id, secret });
}

/**
 * Replicates program-hub event-signature.ts shape.
 * See apps/node/programs-api/src/auth/event-signature.ts.
 */
function readKeyMapFromEnv(): SignatureKeyResolver {
    const raw = (process.env.EVENT_SIGNATURE_VERIFY_KEYS ?? '').trim();
    if (!raw) return () => null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return () => null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return () => null;
    }
    const map = parsed as Record<string, unknown>;
    return (keyId) => {
        const v = map[keyId];
        return typeof v === 'string' ? v : null;
    };
}

function readModeFromEnv(): SignatureMode {
    const raw = (process.env.EVENT_SIGNATURE_ENFORCE ?? '').toLowerCase();
    if (raw === 'true' || raw === '1') return 'enforce';
    if (raw === 'off') return 'off';
    return 'shadow';
}

describe('producer↔consumer signed-event flow (integration)', () => {
    let infra: InfraHandle;
    let pool: Pool;
    let connMgr: ConnectionManager;
    let mqConn: ChannelModel;
    let consumerChannel: Channel;
    let consumerQueue: string;
    const consumed: ConsumedSignal[] = [];
    const originalEnv = { ...process.env };

    beforeAll(async () => {
        infra = await startInfra();
        const dbUrl = await infra.createDatabase('producer_consumer_flow');
        await infra.runSql(dbUrl, OUTBOX_EVENT_SQL);
        pool = new Pool({ connectionString: dbUrl });

        connMgr = new ConnectionManager(noopLogger, { url: infra.rabbitmqUrl });
        await connMgr.connect();

        mqConn = await amqplib.connect(infra.rabbitmqUrl);
        consumerChannel = await mqConn.createChannel();
        await consumerChannel.assertExchange(EXCHANGE, 'topic', { durable: true });
        consumerQueue = `consumer.flow.${Date.now()}`;
        // Not exclusive / not autoDelete — each scenario starts and
        // cancels its own consumer, and we don't want the queue to vanish
        // between scenarios when the consumer count momentarily hits 0.
        await consumerChannel.assertQueue(consumerQueue, {
            durable: false,
            autoDelete: false,
            exclusive: false,
        });
        await consumerChannel.bindQueue(consumerQueue, EXCHANGE, '#');
    }, 120_000);

    afterAll(async () => {
        process.env = originalEnv;
        try {
            await consumerChannel?.close();
            await mqConn?.close();
        } catch {}
        try {
            await pool?.end();
        } catch {}
        await infra?.stop();
    });

    /**
     * Spawns a simple consumer that mirrors program-hub's
     * withSignatureVerification: parse → decideSignature → accept-or-throw.
     * Returns a stop function. Each invocation builds resolver/mode from
     * the *current* env vars (test mutates between scenarios).
     */
    async function startConsumer(): Promise<() => Promise<void>> {
        // Drain any leftover messages from previous scenarios before
        // attaching the new consumer — otherwise stale messages signed
        // with a previous scenario's key get re-evaluated under the
        // current scenario's resolver and pollute `consumed`.
        await consumerChannel.purgeQueue(consumerQueue);

        const resolveKey = readKeyMapFromEnv();
        const mode = readModeFromEnv();
        const consumerTag = `tag-${Date.now()}-${Math.random()}`;
        let stopped = false;

        void consumerChannel.consume(
            consumerQueue,
            async (msg) => {
                if (!msg || stopped) return;
                try {
                    const envelope = JSON.parse(
                        msg.content.toString('utf8'),
                    ) as EventEnvelope;
                    const decision = await decideSignature(envelope, resolveKey, mode);
                    const accepted = decision.action !== 'reject';
                    consumed.push({ envelope, decision, accepted });
                } finally {
                    consumerChannel.ack(msg);
                }
            },
            { consumerTag },
        );

        return async () => {
            stopped = true;
            try {
                await consumerChannel.cancel(consumerTag);
            } catch {}
        };
    }

    function newRelay(): OutboxRelay {
        return new OutboxRelay({
            pool,
            connectionManager: connMgr,
            exchange: EXCHANGE,
            pollIntervalMs: 100,
            logger: noopLogger,
            transformEnvelope: buildProducerTransform(),
        });
    }

    async function insertRow(eventId: string, payload: object): Promise<void> {
        await pool.query(
            `INSERT INTO outbox_event (
                event_id, aggregate_type, aggregate_id, event_type,
                event_version, payload, occurred_at
             ) VALUES ($1::uuid, 'user', $2, 'identity.user.created',
                       1, $3::jsonb, NOW())`,
            [eventId, `agg-${Date.now()}`, JSON.stringify(payload)],
        );
    }

    async function waitForConsumed(
        eventId: string,
        timeoutMs = 5_000,
    ): Promise<ConsumedSignal> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = consumed.find((c) => c.envelope.eventId === eventId);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timeout waiting for consumed event ${eventId}`);
    }

    function newUuid(): string {
        return (
            '00000000-0000-4000-8000-' +
            Math.floor(Math.random() * 0xffffffffffff)
                .toString(16)
                .padStart(12, '0')
        );
    }

    it('producer signs with key-v1, consumer with key-v1 in resolver: status=valid', async () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: KEY_ID_V1,
            EVENT_SIGNING_SECRET: SECRET_V1,
            EVENT_SIGNATURE_VERIFY_KEYS: JSON.stringify({ [KEY_ID_V1]: SECRET_V1 }),
            EVENT_SIGNATURE_ENFORCE: 'true',
        };
        const stopConsumer = await startConsumer();
        const relay = newRelay();
        await relay.start();

        const eventId = newUuid();
        await insertRow(eventId, { userId: 'flow-1', name: 'Valid Flow' });

        const sig = await waitForConsumed(eventId);
        expect(sig.envelope.meta?.signature?.keyId).toBe(KEY_ID_V1);
        expect(sig.decision.status).toBe('valid');
        expect(sig.decision.action).toBe('allow');
        expect(sig.accepted).toBe(true);

        await relay.stop();
        await stopConsumer();
    });

    it('producer signs with key-v2, consumer only knows key-v1: enforce → reject', async () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: KEY_ID_V2,
            EVENT_SIGNING_SECRET: SECRET_V2,
            EVENT_SIGNATURE_VERIFY_KEYS: JSON.stringify({ [KEY_ID_V1]: SECRET_V1 }),
            EVENT_SIGNATURE_ENFORCE: 'true',
        };
        const stopConsumer = await startConsumer();
        const relay = newRelay();
        await relay.start();

        const eventId = newUuid();
        await insertRow(eventId, { userId: 'flow-2' });

        const sig = await waitForConsumed(eventId);
        expect(sig.envelope.meta?.signature?.keyId).toBe(KEY_ID_V2);
        expect(sig.decision.status).toBe('unknown_key');
        expect(sig.decision.action).toBe('reject');
        expect(sig.accepted).toBe(false);

        await relay.stop();
        await stopConsumer();
    });

    it('producer signs with key-v2, consumer only knows key-v1: shadow → log+allow', async () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: KEY_ID_V2,
            EVENT_SIGNING_SECRET: SECRET_V2,
            EVENT_SIGNATURE_VERIFY_KEYS: JSON.stringify({ [KEY_ID_V1]: SECRET_V1 }),
            EVENT_SIGNATURE_ENFORCE: '',
        };
        const stopConsumer = await startConsumer();
        const relay = newRelay();
        await relay.start();

        const eventId = newUuid();
        await insertRow(eventId, { userId: 'flow-3' });

        const sig = await waitForConsumed(eventId);
        expect(sig.decision.status).toBe('unknown_key');
        expect(sig.decision.action).toBe('log');
        expect(sig.accepted).toBe(true);

        await relay.stop();
        await stopConsumer();
    });

    it('key rotation: consumer with both keys accepts events from either producer key', async () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: KEY_ID_V1,
            EVENT_SIGNING_SECRET: SECRET_V1,
            EVENT_SIGNATURE_VERIFY_KEYS: JSON.stringify({
                [KEY_ID_V1]: SECRET_V1,
                [KEY_ID_V2]: SECRET_V2,
            }),
            EVENT_SIGNATURE_ENFORCE: 'true',
        };
        const stopConsumer = await startConsumer();
        const relay = newRelay();
        await relay.start();

        const id1 = newUuid();
        await insertRow(id1, { userId: 'rot-1' });
        const sig1 = await waitForConsumed(id1);
        expect(sig1.decision.status).toBe('valid');
        expect(sig1.envelope.meta?.signature?.keyId).toBe(KEY_ID_V1);

        await relay.stop();

        // Operator rotates the producer to v2. Consumer is unchanged.
        process.env.EVENT_SIGNING_KEY_ID = KEY_ID_V2;
        process.env.EVENT_SIGNING_SECRET = SECRET_V2;
        const relay2 = newRelay();
        await relay2.start();

        const id2 = newUuid();
        await insertRow(id2, { userId: 'rot-2' });
        const sig2 = await waitForConsumed(id2);
        expect(sig2.decision.status).toBe('valid');
        expect(sig2.envelope.meta?.signature?.keyId).toBe(KEY_ID_V2);

        await relay2.stop();
        await stopConsumer();
    });

    it('producer with no signing config (legacy mode): envelope has no signature; consumer in shadow → status=absent, allow', async () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: '',
            EVENT_SIGNING_SECRET: '',
            EVENT_SIGNATURE_VERIFY_KEYS: JSON.stringify({ [KEY_ID_V1]: SECRET_V1 }),
            EVENT_SIGNATURE_ENFORCE: '',
        };
        const stopConsumer = await startConsumer();
        const relay = newRelay();
        await relay.start();

        const eventId = newUuid();
        await insertRow(eventId, { userId: 'legacy-1' });

        const sig = await waitForConsumed(eventId);
        expect(sig.envelope.meta?.signature).toBeUndefined();
        expect(sig.decision.status).toBe('absent');
        expect(sig.decision.action).toBe('log');
        expect(sig.accepted).toBe(true);

        await relay.stop();
        await stopConsumer();
    });

    it('half-configured producer (key without secret) throws at startup', () => {
        process.env = {
            ...originalEnv,
            EVENT_SIGNING_KEY_ID: KEY_ID_V1,
            EVENT_SIGNING_SECRET: '',
        };
        expect(() => buildProducerTransform()).toThrow(/must both be set/);
    });
});
