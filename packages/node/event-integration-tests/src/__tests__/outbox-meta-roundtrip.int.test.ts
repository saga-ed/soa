import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import amqplib, { type Channel, type ChannelModel } from 'amqplib';
import { Pool } from 'pg';
import { startInfra, type InfraHandle } from '@saga-ed/soa-event-test-harness';
import {
    IDENTITY_SVC,
    migrate,
    spawnService,
    type SpawnedService,
} from '../lib/services.js';
import { trpcMutate } from '../lib/trpc-fetch.js';
import { waitForReady } from '../lib/wait.js';

interface CreatedUser {
    id: string;
    name: string;
    email: string;
    createdAt: string;
}

interface PublishedMessage {
    eventId: string;
    eventType: string;
    eventVersion: number;
    aggregateType: string;
    aggregateId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
    meta?: Record<string, string>;
}

/**
 * Verifies that the meta JSONB column added in 20260501033000_add_outbox_meta
 * round-trips through outbox → relay → broker → consumer:
 *   1. Real publish has the wire shape we expect (broker message includes
 *      eventId / payload / etc) — catches relay regressions.
 *   2. meta INSERT'd into the outbox row is republished verbatim into
 *      message.meta — catches relay regression OR the meta column being
 *      dropped from the SELECT.
 *
 * This is the regression guard for the trace-context propagation chain
 * even though the test doesn't itself use OTel — if either of these two
 * properties breaks, cross-service trace continuity silently fails.
 */
describe('outbox meta round-trip (integration)', () => {
    let infra: InfraHandle;
    let identity: SpawnedService;
    let identityDbUrl: string;
    let mqConn: ChannelModel;
    let snifferChannel: Channel;
    const sniffQueue = `test.sniffer.${Date.now()}`;

    beforeAll(async () => {
        infra = await startInfra();
        identityDbUrl = await infra.createDatabase('identity_meta_test');
        migrate(IDENTITY_SVC, identityDbUrl);

        identity = spawnService({
            serviceDir: IDENTITY_SVC,
            port: 4011,
            env: {
                NODE_ENV: 'test',
                LOG_LEVEL: 'warn',
                DATABASE_URL: identityDbUrl,
                RABBITMQ_URL: infra.rabbitmqUrl,
                EVENTS_EXCHANGE: 'identity.events',
            },
        });
        await waitForReady(identity.baseUrl);

        // Sniffer queue: ephemeral exclusive queue bound to identity.events
        // with `#` so we capture every message the relay publishes. The
        // identity-svc startup already asserted the exchange.
        mqConn = await amqplib.connect(infra.rabbitmqUrl);
        snifferChannel = await mqConn.createChannel();
        await snifferChannel.assertQueue(sniffQueue, {
            durable: false,
            autoDelete: true,
            exclusive: true,
        });
        await snifferChannel.bindQueue(sniffQueue, 'identity.events', '#');
    }, 120_000);

    afterAll(async () => {
        try {
            await snifferChannel?.close();
            await mqConn?.close();
        } catch {
            // already closed
        }
        await identity?.stop();
        await infra?.stop();
    });

    it('publishes the canonical wire shape to the broker', async () => {
        const created = await trpcMutate<CreatedUser>(identity.baseUrl, 'users.create', {
            name: 'Wire Test',
            email: `wire-${Date.now()}@example.com`,
        });

        const messages = await collectMessages(snifferChannel, sniffQueue, {
            timeoutMs: 5_000,
            until: (msgs) =>
                msgs.some(
                    (m) => m.eventType === 'identity.user.created' && m.aggregateId === created.id,
                ),
        });

        const userCreated = messages.find(
            (m) => m.eventType === 'identity.user.created' && m.aggregateId === created.id,
        );
        expect(userCreated).toBeDefined();
        expect(userCreated!.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(userCreated!.eventVersion).toBeGreaterThanOrEqual(1);
        expect(userCreated!.aggregateType).toBe('user');
        expect(userCreated!.occurredAt).toBeDefined();
        expect(userCreated!.payload.userId).toBe(created.id);
        expect(userCreated!.payload.email).toBe(created.email);
    });

    it('round-trips meta JSONB from outbox row through to broker message', async () => {
        // Insert a synthetic outbox row with meta — bypassing the publisher
        // path so we can isolate the relay's read+publish behavior. We use
        // a valid traceparent format (00-traceid-spanid-flags) so any
        // future Zod re-validation in the consumer would also accept it.
        const pool = new Pool({ connectionString: identityDbUrl });
        const eventId = '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0');
        const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
        try {
            await pool.query(
                `INSERT INTO outbox_event (
                    event_id, aggregate_type, aggregate_id, event_type,
                    event_version, payload, meta, occurred_at
                ) VALUES (
                    $1::uuid, 'user', $2, 'identity.user.created',
                    1, $3::jsonb, $4::jsonb, NOW()
                )`,
                [
                    eventId,
                    'meta-roundtrip-' + Date.now(),
                    JSON.stringify({
                        userId: 'meta-roundtrip-test',
                        name: 'Meta Roundtrip',
                        email: 'meta@example.com',
                        createdAt: new Date().toISOString(),
                    }),
                    JSON.stringify({ traceparent }),
                ],
            );
        } finally {
            await pool.end();
        }

        const messages = await collectMessages(snifferChannel, sniffQueue, {
            timeoutMs: 5_000,
            until: (msgs) => msgs.some((m) => m.eventId === eventId),
        });

        const ours = messages.find((m) => m.eventId === eventId);
        expect(ours).toBeDefined();
        expect(ours!.meta).toBeDefined();
        // Note: relay re-injects publish-span context AFTER the row's
        // traceparent, so message.meta.traceparent is the publish span's
        // — not byte-equal to the row's — but it's still a valid W3C
        // traceparent string. Without OTel SDK in this test process,
        // propagation.inject is a no-op so the original survives.
        expect(typeof ours!.meta!.traceparent).toBe('string');
        expect(ours!.meta!.traceparent).toBe(traceparent);
    });
});

interface CollectOpts {
    timeoutMs: number;
    until: (msgs: PublishedMessage[]) => boolean;
}

async function collectMessages(
    channel: Channel,
    queue: string,
    opts: CollectOpts,
): Promise<PublishedMessage[]> {
    const collected: PublishedMessage[] = [];
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
        const msg = await channel.get(queue, { noAck: true });
        if (msg) {
            collected.push(JSON.parse(msg.content.toString('utf8')) as PublishedMessage);
            if (opts.until(collected)) return collected;
        } else {
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    return collected;
}
