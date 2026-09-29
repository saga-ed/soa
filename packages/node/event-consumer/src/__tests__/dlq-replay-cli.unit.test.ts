// Unit tests for runDlqReplayCli — the operator-facing entry point.
//
// Two things are being asserted, and only one of them is obvious. The obvious
// one is the exit code: a refusal and a half-finished replay must not look like
// a clean run to whatever called the script. The other is that the broker
// connection is CLOSED on every path, because a live AMQP socket holds Node's
// event loop open and a CLI that leaks one hangs after printing its report —
// which reads, to the operator watching, exactly like the replay itself being
// stuck.
//
// The channel is faked (no broker); `dlq-replay.int.test.ts` covers the real
// one. What is deliberately NOT faked is the connection's close: each test
// counts it.

import { describe, expect, it, vi } from 'vitest';
import type { ILogger } from '@saga-ed/soa-logger';
import { runDlqReplayCli, type DlqReplayConnection } from '../dlq-replay-cli.js';
import type { DlqChannel, DlqRawMessage } from '../dlq-replay-runner.js';

const TARGET_QUEUE = 'coach-api.instance-creation';
const DLQ = 'iam.events.dlq.queue';
const EVENT_TYPE = 'iam.persona_assignment.added';

const logger: ILogger = { info() {}, warn() {}, error() {}, debug() {} };

function envelope(eventId: string): Buffer {
    return Buffer.from(
        JSON.stringify({
            eventId,
            eventType: EVENT_TYPE,
            eventVersion: 1,
            aggregateType: 'persona_assignment',
            aggregateId: `agg-${eventId.slice(-4)}`,
            occurredAt: '2026-09-16T14:29:00Z',
            payload: { id: 'x' },
        }),
    );
}

function raw(eventId: string): DlqRawMessage {
    return {
        content: envelope(eventId),
        fields: { routingKey: EVENT_TYPE },
        properties: {
            contentType: 'application/json',
            messageId: eventId,
            headers: {
                'x-first-death-queue': TARGET_QUEUE,
                'x-first-death-reason': 'rejected',
                'x-death': [
                    {
                        queue: TARGET_QUEUE,
                        reason: 'rejected',
                        count: 1,
                        time: { '!': 'timestamp', value: 1789000000 },
                        'routing-keys': [EVENT_TYPE],
                    },
                ],
            },
        },
    };
}

const MESSAGE_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

function makeChannel(behaviour: { publishFails?: boolean } = {}): DlqChannel {
    const queue = MESSAGE_IDS.map(raw);
    const channel: DlqChannel = {
        async checkQueue(name: string) {
            return { messageCount: name === DLQ ? MESSAGE_IDS.length : 0 };
        },
        async get() {
            return queue.shift() ?? false;
        },
        nackAll() {},
        publish(_exchange, _routingKey, _content, _options, callback) {
            callback?.(behaviour.publishFails ? new Error('broker said no') : null, {});
            return true;
        },
        async waitForConfirms() {},
        on() {
            return channel;
        },
        async close() {},
    };
    return channel;
}

/**
 * A connection the CLI is expected to close. `newConfirmChannel` after a close
 * throws on purpose: it catches a teardown that runs while the run is still
 * using the connection, which a close-counter alone would not.
 */
function makeConnection(
    channel: DlqChannel | Error,
    opts: { closeFails?: boolean } = {},
): DlqReplayConnection & { closeCount: number; channelCount: number } {
    let closeCount = 0;
    let channelCount = 0;
    return {
        get closeCount() {
            return closeCount;
        },
        get channelCount() {
            return channelCount;
        },
        async newConfirmChannel() {
            if (closeCount > 0) throw new Error('connection was closed before the run finished');
            channelCount += 1;
            if (channel instanceof Error) throw channel;
            return channel;
        },
        async close() {
            closeCount += 1;
            if (opts.closeFails) throw new Error('socket already gone');
        },
    };
}

function collect(): { write: (report: string) => void; output: () => string } {
    const lines: string[] = [];
    return {
        write: (report: string) => lines.push(report),
        output: () => lines.join('\n'),
    };
}

function run(
    connection: DlqReplayConnection,
    values: Parameters<typeof runDlqReplayCli>[0]['values'],
    write: (report: string) => void,
) {
    return runDlqReplayCli({
        values,
        connection,
        dlqQueue: DLQ,
        targetQueue: TARGET_QUEUE,
        defaults: { eventTypes: [EVENT_TYPE] },
        logger,
        write,
    });
}

/**
 * Do what an operator does: run the dry run and read the confirmation off its
 * report. Extracted so a wording change in the report fails HERE, loudly, and
 * not as a mystified `Refused (...)` in whichever test used it next.
 */
async function confirmationFromDryRun(): Promise<string> {
    const out = collect();
    await run(makeConnection(makeChannel()), {}, out.write);
    const confirmation = /--approve --confirm (\w+)/.exec(out.output())?.[1];
    if (!confirmation) throw new Error(`no confirmation in the dry-run report:\n${out.output()}`);
    return confirmation;
}

describe('runDlqReplayCli', () => {
    it('inspects, reports, and closes the connection', async () => {
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await run(connection, { inspect: true }, out.write);

        expect(code).toBe(0);
        expect(out.output()).toContain(`Dead-letter queue: ${DLQ}`);
        expect(connection.closeCount).toBe(1);
    });

    it('exits 2 on a dry run that selected something, and closes', async () => {
        // "Found work but published nothing" has to be distinguishable from
        // "nothing to do" without parsing the report.
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await run(connection, {}, out.write);

        expect(code).toBe(2);
        expect(out.output()).toContain('Dry run — nothing was published');
        expect(connection.closeCount).toBe(1);
    });

    it('exits 0 when the filter matched nothing', async () => {
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await run(connection, { 'event-type': ['iam.something.else'] }, out.write);

        expect(code).toBe(0);
        expect(out.output()).toContain('(nothing matched the filter)');
        expect(connection.closeCount).toBe(1);
    });

    it('exits 0 on an approved replay that published everything, and closes', async () => {
        // The full operator round-trip: dry run, take the confirmation it
        // printed, approve with it.
        const confirm = await confirmationFromDryRun();
        const connection = makeConnection(makeChannel());
        const out = collect();
        const code = await run(connection, { approve: true, confirm }, out.write);

        expect(code).toBe(0);
        expect(out.output()).toContain('Replayed (oldest first):');
        expect(connection.closeCount).toBe(1);
    });

    it('exits 1 when a publish failed — and still closes the connection', async () => {
        const confirm = await confirmationFromDryRun();
        const connection = makeConnection(makeChannel({ publishFails: true }));
        const out = collect();
        const code = await run(connection, { approve: true, confirm }, out.write);

        expect(code).toBe(1);
        expect(out.output()).toContain('FAILED on');
        expect(connection.closeCount).toBe(1);
    });

    it('exits 1 on a refusal, printing the reason, without opening a channel', async () => {
        // The filter is validated before the broker is touched. The connection
        // is still closed: it may have been connected by whoever built it, and
        // closing one that never connected is a no-op.
        //
        // No `defaults` here — a service with no allowlist and an operator who
        // named no types is the run `validateFilter` exists to refuse.
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await runDlqReplayCli({
            values: { 'first-death-queue': 'some.other.queue' },
            connection,
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            logger,
            write: out.write,
        });

        expect(code).toBe(1);
        expect(out.output()).toMatch(/^Refused \(no-filter\): /);
        expect(connection.channelCount).toBe(0);
        expect(connection.closeCount).toBe(1);
    });

    it('refuses an empty --event-type instead of reporting a clean run', async () => {
        // `--event-type ""` parses to [''], which matches nothing. Left alone
        // it selects zero messages, prints "(nothing matched the filter)" and
        // exits 0 — a typo in a runbook step reading as a successful replay,
        // which is the single worst thing this tool could be wrong about.
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await run(connection, { 'event-type': [''] }, out.write);

        expect(code).toBe(1);
        expect(out.output()).toContain('Refused (empty-flag)');
        expect(connection.channelCount).toBe(0);
        expect(connection.closeCount).toBe(1);
    });

    it('exits 1 on a refusal raised by flag parsing', async () => {
        const connection = makeConnection(makeChannel());
        const out = collect();

        const code = await run(connection, { inspect: true, approve: true }, out.write);

        expect(code).toBe(1);
        expect(out.output()).toContain('Refused (inspect-with-approve)');
        expect(connection.closeCount).toBe(1);
    });

    it('closes the connection when the broker throws something unexpected', async () => {
        // A surprise propagates with its stack — but not before the socket is
        // shut, or the process hangs on the error path only, which is the
        // hardest kind of hang to reproduce.
        const connection = makeConnection(new Error('ECONNRESET'));
        const out = collect();

        await expect(run(connection, {}, out.write)).rejects.toThrow('ECONNRESET');

        expect(connection.closeCount).toBe(1);
    });

    it('does not let a failed close replace the run outcome', async () => {
        // Closing a socket the broker already dropped throws. Turning a clean
        // replay into a crash over a tidy-up failure would tell the operator
        // their replay failed when it did not.
        const connection = makeConnection(makeChannel(), { closeFails: true });
        const out = collect();
        const warn = vi.fn();

        const code = await runDlqReplayCli({
            values: {},
            connection,
            dlqQueue: DLQ,
            targetQueue: TARGET_QUEUE,
            defaults: { eventTypes: [EVENT_TYPE] },
            logger: { ...logger, warn },
            write: out.write,
        });

        expect(code).toBe(2);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('could not close the broker connection'),
            expect.anything(),
        );
    });
});
