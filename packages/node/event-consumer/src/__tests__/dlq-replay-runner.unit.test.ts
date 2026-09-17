import { describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@saga-ed/soa-logger';
import { DlqReplayRefusedError } from '../dlq-replay.js';
import {
    formatReplayReport,
    inspectDeadLetterQueue,
    replayDeadLetters,
    type DlqChannel,
    type DlqRawMessage,
} from '../dlq-replay-runner.js';
import { DLQ_REPLAY_CLI_OPTIONS, filterFromCliValues } from '../dlq-replay-cli.js';

/**
 * No broker here — the channel is faked so the refusal and safety rules can be
 * asserted anywhere, including CI. The behaviours that actually matter to an
 * operator are: nothing is ever acked, a copy goes to the target queue via the
 * DEFAULT exchange, a stale confirmation is refused, and a failed publish stops
 * the run where it stands.
 *
 * `dlq-replay.int.test.ts` runs the same paths against a real RabbitMQ.
 */

const TARGET_QUEUE = 'coach-api.instance-creation';
const DLQ = 'iam.events.dlq.queue';

const logger: ILogger = { info() {}, warn() {}, error() {}, debug() {} };

interface PublishRecord {
    exchange: string;
    routingKey: string;
    content: Buffer;
    options: Record<string, unknown>;
}

interface FakeChannel extends DlqChannel {
    published: PublishRecord[];
    acked: number;
    nackAllCalls: boolean[];
    closed: boolean;
}

function envelope(eventId: string, eventType = 'iam.persona_assignment.added'): Buffer {
    return Buffer.from(
        JSON.stringify({
            eventId,
            eventType,
            eventVersion: 1,
            aggregateType: 'persona_assignment',
            aggregateId: `agg-${eventId.slice(-4)}`,
            occurredAt: '2026-09-16T14:29:00Z',
            payload: { id: 'x' },
        }),
    );
}

function raw(
    eventId: string,
    opts: {
        eventType?: string;
        firstDeathQueue?: string;
        time?: number;
        headers?: Record<string, unknown>;
    } = {},
): DlqRawMessage {
    const deathQueue = opts.firstDeathQueue ?? TARGET_QUEUE;
    return {
        content: envelope(eventId, opts.eventType),
        fields: { routingKey: opts.eventType ?? 'iam.persona_assignment.added' },
        properties: {
            contentType: 'application/json',
            messageId: eventId,
            headers: {
                // A header the publisher set, which must survive the replay.
                'x-tenant': 'saga',
                'x-first-death-queue': deathQueue,
                'x-first-death-reason': 'rejected',
                'x-last-death-queue': deathQueue,
                'x-last-death-reason': 'rejected',
                'x-death': [
                    {
                        queue: deathQueue,
                        reason: 'rejected',
                        count: 1,
                        time: { '!': 'timestamp', value: opts.time ?? 1789000000 },
                        'routing-keys': [opts.eventType ?? 'iam.persona_assignment.added'],
                    },
                ],
                ...opts.headers,
            },
        },
    };
}

function makeChannel(
    messages: DlqRawMessage[],
    behaviour: {
        publishError?: Error;
        failOnNth?: number;
        unroutableOnNth?: number;
        /** Emit a return for a body we never published, to test correlation. */
        strayReturnOnNth?: number;
        /** Accept the publish but never call back — a blocked broker. */
        neverConfirm?: boolean;
    } = {},
): FakeChannel {
    const queue = [...messages];
    const published: PublishRecord[] = [];
    const nackAllCalls: boolean[] = [];
    let returnListener: ((msg: DlqRawMessage) => void) | null = null;
    let errorListener: ((err: unknown) => void) | null = null;
    let closeListener: (() => void) | null = null;
    let closed = false;

    const channel: FakeChannel = {
        published,
        acked: 0,
        nackAllCalls,
        get closed() {
            return closed;
        },
        async checkQueue(name: string) {
            if (name !== TARGET_QUEUE && name !== DLQ) {
                // Imitate amqplib: the broker's 404 arrives as a channel 'error'
                // event, the channel dies, and only then does the RPC reject —
                // with a message that says nothing useful. Faking that ordering
                // is the point: it is what makes the runner's 'error' listener
                // load-bearing rather than decorative.
                errorListener?.(new Error(`Channel closed by server: 404 (NOT-FOUND) with message "NOT_FOUND - no queue '${name}'"`));
                closed = true;
                closeListener?.();
                throw new Error('Channel ended, no reply will be forthcoming');
            }
            return { messageCount: name === DLQ ? messages.length : 0 };
        },
        async get() {
            // basic.get hands back each message once while it stays unacked.
            return queue.shift() ?? false;
        },
        nackAll(requeue?: boolean) {
            nackAllCalls.push(requeue ?? false);
        },
        publish(exchange, routingKey, content, options, callback) {
            const nth = published.length + 1;
            if (behaviour.failOnNth === nth) {
                callback?.(behaviour.publishError ?? new Error('broker said no'), null);
                return true;
            }
            if (behaviour.neverConfirm) return true;
            published.push({ exchange, routingKey, content, options: options ?? {} });
            if (behaviour.strayReturnOnNth === nth) {
                returnListener?.(raw('99999999-9999-4999-8999-999999999999'));
            }
            if (behaviour.unroutableOnNth === nth) {
                // basic.return hands back the message you published, body and
                // all — which is what lets the runner tell WHICH publish was
                // unroutable rather than assuming it was the most recent one.
                returnListener?.({
                    content,
                    fields: { routingKey },
                    properties: { headers: options?.headers as Record<string, unknown> },
                });
            }
            callback?.(null, {});
            return true;
        },
        async waitForConfirms() {},
        on(event: 'return' | 'error' | 'close', listener: (arg?: never) => void) {
            if (event === 'return') returnListener = listener as (msg: DlqRawMessage) => void;
            if (event === 'error') errorListener = listener as (err: unknown) => void;
            if (event === 'close') closeListener = listener as () => void;
            return channel;
        },
        async close() {
            closed = true;
        },
    };
    return channel;
}

function source(channel: DlqChannel) {
    return { async newConfirmChannel() { return channel; } };
}

describe('inspectDeadLetterQueue', () => {
    it('reads everything, groups it, and acknowledges nothing', async () => {
        const channel = makeChannel([
            raw('11111111-1111-4111-8111-111111111111'),
            raw('22222222-2222-4222-8222-222222222222'),
            raw('33333333-3333-4333-8333-333333333333', {
                firstDeathQueue: 'sessions-api.iam-projection',
            }),
        ]);

        const inspection = await inspectDeadLetterQueue({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            logger,
        });

        expect(inspection.messages).toHaveLength(3);
        expect(inspection.queueDepth).toBe(3);
        expect(inspection.scanTruncated).toBe(false);
        expect(inspection.groups.reduce((sum, g) => sum + g.count, 0)).toBe(3);
        // Everything went back; nothing was consumed.
        expect(channel.published).toHaveLength(0);
        expect(channel.nackAllCalls).toEqual([true]);
        expect(channel.closed).toBe(true);
    });

    it('stops at the scan limit and says so', async () => {
        const channel = makeChannel([
            raw('11111111-1111-4111-8111-111111111111'),
            raw('22222222-2222-4222-8222-222222222222'),
        ]);
        const inspection = await inspectDeadLetterQueue({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            scanLimit: 1,
            logger,
        });
        expect(inspection.messages).toHaveLength(1);
        expect(inspection.scanTruncated).toBe(true);
    });

    it('does not claim truncation when the queue holds exactly the scan limit', async () => {
        // "Read scanLimit messages" is not the same as "stopped early". Getting
        // this wrong tells an operator to raise --scan-limit when they already
        // have everything — and now also refuses their approve.
        const channel = makeChannel([
            raw('11111111-1111-4111-8111-111111111111'),
            raw('22222222-2222-4222-8222-222222222222'),
        ]);
        const inspection = await inspectDeadLetterQueue({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            scanLimit: 2,
            logger,
        });
        expect(inspection.messages).toHaveLength(2);
        expect(inspection.scanTruncated).toBe(false);
    });

    it('refuses an out-of-range scan limit', async () => {
        await expect(
            inspectDeadLetterQueue({
                connectionManager: source(makeChannel([])),
                dlqQueue: DLQ,
                scanLimit: 99_999,
                logger,
            }),
        ).rejects.toThrow(DlqReplayRefusedError);
    });
});

describe('replayDeadLetters', () => {
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';

    it('refuses an untargeted run before it opens a channel', async () => {
        const newConfirmChannel = vi.fn();
        await expect(
            replayDeadLetters({
                connectionManager: { newConfirmChannel },
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                filter: {},
                logger,
            }),
        ).rejects.toThrow(/Refusing to run without a filter/);
        expect(newConfirmChannel).not.toHaveBeenCalled();
    });

    it('refuses an approve with no confirmation, without opening a channel', async () => {
        const newConfirmChannel = vi.fn();
        await expect(
            replayDeadLetters({
                connectionManager: { newConfirmChannel },
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                filter: { eventTypes: ['iam.persona_assignment.added'] },
                approve: true,
                logger,
            }),
        ).rejects.toThrow(/without a confirmation value/);
        expect(newConfirmChannel).not.toHaveBeenCalled();
    });

    it('dry-runs: selects, prints a confirmation, publishes nothing', async () => {
        const channel = makeChannel([raw(idA), raw(idB)]);
        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        expect(result.approved).toBe(false);
        expect(result.selection.selected).toHaveLength(2);
        expect(result.replayed).toEqual([]);
        expect(channel.published).toHaveLength(0);
        expect(result.selection.confirmation).toMatch(/^[0-9a-f]{12}$/);
        expect(formatReplayReport(result)).toContain(
            `--approve --confirm ${result.selection.confirmation}`,
        );
        expect(formatReplayReport(result)).toContain('remains a broker-admin action');
    });

    it('refuses an approve whose confirmation no longer matches the queue', async () => {
        const dryRunChannel = makeChannel([raw(idA), raw(idB)]);
        const dryRun = await replayDeadLetters({
            connectionManager: source(dryRunChannel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        // One of the two was drained between the dry run and the approve.
        const changed = makeChannel([raw(idA)]);
        await expect(
            replayDeadLetters({
                connectionManager: source(changed),
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                filter: { eventTypes: ['iam.persona_assignment.added'] },
                approve: true,
                confirm: dryRun.selection.confirmation,
                logger,
            }),
        ).rejects.toThrow(/does not match what is on the queue now/);
        expect(changed.published).toHaveLength(0);
        // Still gave everything back.
        expect(changed.nackAllCalls).toEqual([true]);
    });

    it('publishes a copy to the default exchange keyed by the target queue, acking nothing', async () => {
        const channel = makeChannel([raw(idA), raw(idB)]);
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel([raw(idA), raw(idB)])),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });

        expect(result.approved).toBe(true);
        expect(result.replayed).toHaveLength(2);
        expect(result.failure).toBeNull();
        expect(channel.published).toHaveLength(2);
        for (const record of channel.published) {
            // Default exchange + queue name as the routing key: only this queue
            // receives it, never the other consumers on the topic exchange.
            expect(record.exchange).toBe('');
            expect(record.routingKey).toBe(TARGET_QUEUE);
            expect(record.options.persistent).toBe(true);
            expect(record.options.mandatory).toBe(true);
            const headers = record.options.headers as Record<string, unknown>;
            // The broker's death bookkeeping is dropped so a second failure
            // records a fresh death naming the TARGET queue. All three families
            // go, including the x-last-death-* trio RabbitMQ 3.13 added.
            expect(headers['x-death']).toBeUndefined();
            expect(headers['x-first-death-queue']).toBeUndefined();
            expect(headers['x-first-death-reason']).toBeUndefined();
            expect(headers['x-last-death-queue']).toBeUndefined();
            expect(headers['x-last-death-reason']).toBeUndefined();
            // Anything the publisher set is carried across untouched.
            expect(headers['x-tenant']).toBe('saga');
            expect(headers['x-saga-replayed-from']).toBe(DLQ);
            expect(headers['x-saga-replay-first-death-queue']).toBe(TARGET_QUEUE);
        }
        // The originals are still on the DLQ.
        expect(channel.nackAllCalls).toEqual([true]);
    });

    it('never publishes a message that died on another service’s queue', async () => {
        const theirs = raw('33333333-3333-4333-8333-333333333333', {
            firstDeathQueue: 'sessions-api.iam-projection',
        });
        const channel = makeChannel([raw(idA), theirs]);
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel([raw(idA), theirs])),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });

        expect(result.replayed).toHaveLength(1);
        expect(channel.published).toHaveLength(1);
        expect(channel.published[0]?.content.toString()).toContain(idA);
    });

    it('refuses an approve that selected nothing', async () => {
        const channel = makeChannel([raw(idA)]);
        const empty = makeChannel([]);
        const dryRun = await replayDeadLetters({
            connectionManager: source(empty),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['nobody.emits.this'] },
            logger,
        });
        await expect(
            replayDeadLetters({
                connectionManager: source(channel),
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                filter: { eventTypes: ['nobody.emits.this'] },
                approve: true,
                confirm: dryRun.selection.confirmation,
                logger,
            }),
        ).rejects.toThrow(/selected no messages/);
    });

    it('stops on the first publish failure and reports where it stopped', async () => {
        const messages = [raw(idA), raw(idB), raw('44444444-4444-4444-8444-444444444444')];
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel(messages.map(m => ({ ...m })))),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const channel = makeChannel(messages, { failOnNth: 2, publishError: new Error('nacked') });
        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });

        expect(result.replayed).toHaveLength(1);
        expect(result.failure?.error).toBe('nacked');
        // The third was never attempted.
        expect(channel.published).toHaveLength(1);
        const report = formatReplayReport(result);
        expect(report).toContain('NOT SENT');
        expect(report).toContain('Nothing was lost.');
    });

    it('gives up on a publish the broker never confirms, instead of hanging', async () => {
        // RabbitMQ blocks publishers under a memory/disk alarm: the publish is
        // accepted and the confirm never comes. A hung CLI holding the DLQ's
        // messages unacked is the worst outcome during an incident.
        const messages = [raw(idA), raw(idB)];
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel(messages)),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const channel = makeChannel(messages, { neverConfirm: true });
        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            publishTimeoutMs: 20,
            logger,
        });

        expect(result.replayed).toEqual([]);
        expect(result.failure?.error).toMatch(/did not confirm the publish within 20ms/);
        // Failing safe: the originals were never acked, so nothing was lost.
        expect(channel.nackAllCalls).toEqual([true]);
    });

    it('treats a message the broker returns as unroutable as a failure', async () => {
        const messages = [raw(idA), raw(idB)];
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel(messages.map(m => ({ ...m })))),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const channel = makeChannel(messages, { unroutableOnNth: 1 });
        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });

        expect(result.replayed).toEqual([]);
        expect(result.failure?.error).toMatch(/unroutable/);
    });

    it('does not blame a message for someone else’s unroutable return', async () => {
        // Correlated by body, not by "something showed up since the last
        // publish" — otherwise a stray or late return would mark a good publish
        // failed and the failed one sent.
        const messages = [raw(idA), raw(idB)];
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel(messages)),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });

        const channel = makeChannel(messages, { strayReturnOnNth: 1 });
        const result = await replayDeadLetters({
            connectionManager: source(channel),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            approve: true,
            confirm: dryRun.selection.confirmation,
            logger,
        });

        expect(result.failure).toBeNull();
        expect(result.replayed).toHaveLength(2);
    });
    it('refuses a typo’d destination with what the broker said, before reading anybody’s messages', async () => {
        const channel = makeChannel([raw(idA)]);
        // A channel-level 404 crashes the process if nothing listens for the
        // channel's 'error' event, and hangs the caller forever because amqplib
        // never gets as far as rejecting the RPC. Both were real bugs here.
        await expect(
            replayDeadLetters({
                connectionManager: source(channel),
                dlqQueue: DLQ,
                targetQueue: 'coach-api.typo',
                filter: { eventTypes: ['iam.persona_assignment.added'] },
                logger,
            }),
        ).rejects.toThrow(/Cannot use queue "coach-api\.typo".*NOT_FOUND - no queue/s);
        expect(channel.published).toHaveLength(0);
        // No pointless nackAll on a channel the broker already tore down.
        expect(channel.nackAllCalls).toEqual([]);
    });

    it('refuses an approve when the scan only saw part of the queue', async () => {
        // Otherwise the dry run and the approve can read different windows and
        // disagree forever: the one refusal a retry can never clear.
        const messages = [raw(idA), raw(idB), raw('44444444-4444-4444-8444-444444444444')];
        const dryRun = await replayDeadLetters({
            connectionManager: source(makeChannel(messages)),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            scanLimit: 2,
            logger,
        });
        expect(dryRun.inspection.scanTruncated).toBe(true);

        const channel = makeChannel(messages);
        await expect(
            replayDeadLetters({
                connectionManager: source(channel),
                dlqQueue: DLQ,
                targetQueue: TARGET_QUEUE,
                filter: { eventTypes: ['iam.persona_assignment.added'] },
                scanLimit: 2,
                approve: true,
                confirm: dryRun.selection.confirmation,
                logger,
            }),
        ).rejects.toThrow(/more than 2 messages.*Raise --scan-limit/s);
        expect(channel.published).toHaveLength(0);
    });

    it('warns loudly when the first-death queue is not the target queue', async () => {
        // The one setting that reaches messages which are not this consumer's
        // own. Legitimate after a queue rename, never something that should
        // happen quietly.
        const warn = vi.fn();
        const theirs = raw('33333333-3333-4333-8333-333333333333', {
            firstDeathQueue: 'sessions-api.iam-projection',
        });
        const result = await replayDeadLetters({
            connectionManager: source(makeChannel([raw(idA), theirs])),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: {
                firstDeathQueue: 'sessions-api.iam-projection',
                eventTypes: ['iam.persona_assignment.added'],
            },
            logger: { ...logger, warn },
        });

        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('died on ANOTHER queue'),
            expect.objectContaining({ firstDeathQueue: 'sessions-api.iam-projection' }),
        );
        expect(formatReplayReport(result)).toContain('NOT this consumer’s own queue');
        // It did select theirs — the operator asked for exactly that — and the
        // message that died on the target queue is now the one skipped.
        expect(result.selection.selected).toHaveLength(1);
        expect(result.selection.selected[0]?.firstDeathQueue).toBe('sessions-api.iam-projection');
        expect(result.selection.decisions[0]?.reason).toBe('not-target-queue');
    });

    it('does not warn on the normal path', async () => {
        const warn = vi.fn();
        await replayDeadLetters({
            connectionManager: source(makeChannel([raw(idA)])),
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger: { ...logger, warn },
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('calls ensureConnected when the source has one', async () => {
        const ensureConnected = vi.fn(async () => {});
        const channel = makeChannel([]);
        await replayDeadLetters({
            connectionManager: { ensureConnected, newConfirmChannel: async () => channel },
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            filter: { eventTypes: ['iam.persona_assignment.added'] },
            logger,
        });
        expect(ensureConnected).toHaveBeenCalledOnce();
    });
});

describe('filterFromCliValues', () => {
    it('uses the service allowlist when the operator names no types', () => {
        const args = filterFromCliValues({}, { eventTypes: ['iam.persona_assignment.added'] });
        expect(args.filter.eventTypes).toEqual(['iam.persona_assignment.added']);
        expect(args.approve).toBe(false);
    });

    it('replaces, not widens, when the operator names types', () => {
        const args = filterFromCliValues(
            { 'event-type': ['iam.persona_assignment.removed'] },
            { eventTypes: ['iam.persona_assignment.added'] },
        );
        expect(args.filter.eventTypes).toEqual(['iam.persona_assignment.removed']);
    });

    it('refuses --inspect together with --approve rather than ignoring one', () => {
        // Silently dropping the approve would leave an operator believing a
        // replay had happened.
        expect(() => filterFromCliValues({ inspect: true, approve: true })).toThrow(
            /--inspect only reads the queue/,
        );
        expect(() => filterFromCliValues({ inspect: true, confirm: 'abc123def456' })).toThrow(
            /--inspect only reads the queue/,
        );
        expect(() => filterFromCliValues({ inspect: true })).not.toThrow();
    });

    it('refuses a date it cannot read, and a count that is not a whole number', () => {
        expect(() => filterFromCliValues({ since: 'yesterday-ish' })).toThrow(
            /not a date this can read/,
        );
        expect(() => filterFromCliValues({ max: '1e3' })).toThrow(/whole number/);
        expect(() => filterFromCliValues({ 'scan-limit': '-5' })).toThrow(/whole number/);
    });

    it('refuses a flag given with an empty value rather than dropping it', () => {
        // `--since ""` silently ignored would widen the selection past what the
        // operator believes they typed.
        expect(() => filterFromCliValues({ since: '' })).toThrow(/--since was given with an empty/);
        expect(() => filterFromCliValues({ until: '   ' })).toThrow(/--until was given/);
        expect(() => filterFromCliValues({ max: '' })).toThrow(/--max was given/);
        expect(() => filterFromCliValues({ 'first-death-queue': '' })).toThrow(
            /--first-death-queue was given/,
        );
        expect(() => filterFromCliValues({ 'scan-limit': '' })).toThrow(/--scan-limit was given/);
        expect(() => filterFromCliValues({ confirm: '' })).toThrow(/--confirm was given/);
    });

    it('produces a filter that still has to be targeted', () => {
        // Empty service allowlist + nothing typed = no targeting, and the
        // downstream validate refuses it.
        const args = filterFromCliValues({}, { eventTypes: [] });
        expect(args.filter.eventTypes).toBeUndefined();
    });

    it('exposes an option spec parseArgs accepts', () => {
        expect(DLQ_REPLAY_CLI_OPTIONS['event-type']).toEqual({ type: 'string', multiple: true });
        expect(DLQ_REPLAY_CLI_OPTIONS.approve).toEqual({ type: 'boolean', default: false });
    });
});
