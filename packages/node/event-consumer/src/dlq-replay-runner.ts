// Targeted dead-letter inspection + replay — the broker half.
//
// Uses nothing but AMQP, on the calling service's OWN broker credentials: no
// management HTTP API, no admin secret, no VPN-only console. Everything a
// service already needs to consume its queue is enough to run this.
//
// NOTHING IS EVER ACKED OR DELETED. Both operations read with
// `basic.get(noAck: false)` and requeue every message at the end, so the DLQ is
// exactly as it was before the run. A replay PUBLISHES A COPY to the target
// queue and leaves the original where it is — which means a botched run can
// duplicate a message (harmless, `consumed_events` dedups it) but can never
// lose one. Draining the DLQ afterwards stays a deliberate admin action; this
// tool will not do it, and says so in its own output.
//
// Replay publishes to the DEFAULT EXCHANGE ('') with the target queue's name as
// the routing key. The default exchange routes to the queue of exactly that
// name and nowhere else, so no other consumer bound to the original topic
// exchange sees the replayed copy. That is the difference between "put my 15
// messages back" and "re-broadcast 15 events to every service that was
// listening at the time".
//
// Two caveats worth knowing before running it:
//   - Requeueing at the end of a scan does not guarantee the DLQ's original
//     order is preserved. For a recovery queue nobody consumes, that costs
//     nothing; it is still worth knowing.
//   - While a scan holds messages unacked they are invisible to anything else
//     reading the same DLQ. Runs are short; do not run two at once.

import type { ILogger } from '@saga-ed/soa-logger';
import {
    DEFAULT_SCAN_LIMIT,
    DlqReplayRefusedError,
    REPLAY_AT_HEADER,
    REPLAY_DEATH_QUEUE_HEADER,
    REPLAY_SOURCE_HEADER,
    SCAN_LIMIT_CEILING,
    describeDlqMessage,
    groupDlqMessages,
    selectForReplay,
    validateFilter,
    type DlqDecision,
    type DlqGroupCount,
    type DlqMessage,
    type DlqReplayFilter,
    type DlqSelection,
} from './dlq-replay.js';

/** The shape of an AMQP message this module reads. `amqplib`'s `GetMessage` fits. */
export interface DlqRawMessage {
    content: Buffer;
    fields: { routingKey: string };
    properties: {
        headers?: Record<string, unknown> | undefined;
        contentType?: unknown;
        contentEncoding?: unknown;
        correlationId?: unknown;
        messageId?: unknown;
        timestamp?: unknown;
        type?: unknown;
        appId?: unknown;
    };
}

/**
 * The slice of an `amqplib` `ConfirmChannel` this module uses. Declared
 * structurally rather than importing the class so unit tests can pass a fake
 * without a broker, and so the package does not gain a value-level dependency
 * on amqplib for a feature most callers never touch.
 */
export interface DlqChannel {
    checkQueue(queue: string): Promise<{ messageCount: number }>;
    get(queue: string, options?: { noAck?: boolean }): Promise<DlqRawMessage | false>;
    nackAll(requeue?: boolean): void;
    publish(
        exchange: string,
        routingKey: string,
        content: Buffer,
        options?: Record<string, unknown>,
        callback?: (err: unknown, ok: unknown) => void,
    ): boolean;
    waitForConfirms(): Promise<void>;
    on(event: 'return', listener: (msg: DlqRawMessage) => void): unknown;
    on(event: 'error', listener: (err: unknown) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    close(): Promise<void>;
}

/** `@saga-ed/soa-rabbitmq`'s `ConnectionManager` satisfies this. */
export interface DlqChannelSource {
    ensureConnected?(): Promise<void>;
    newConfirmChannel(): Promise<DlqChannel>;
}

export interface DlqInspectOptions {
    connectionManager: DlqChannelSource;
    /** The dead-letter queue to read, e.g. `iam.events.dlq.queue`. */
    dlqQueue: string;
    /** How many messages to pull before stopping. Default `DEFAULT_SCAN_LIMIT`. */
    scanLimit?: number;
    logger: ILogger;
}

export interface DlqInspection {
    dlqQueue: string;
    /** Broker-reported depth at the start of the scan. */
    queueDepth: number;
    /** Every message read, in queue order. */
    messages: readonly DlqMessage[];
    /** Counts by first-death queue, routing key and death minute. */
    groups: readonly DlqGroupCount[];
    /** True when the scan limit was hit before the queue ran out. */
    scanTruncated: boolean;
}

export interface DlqReplayOptions extends DlqInspectOptions {
    /**
     * The queue to publish copies into — the caller's OWN consumer queue. Used
     * as the routing key on the default exchange, and as the default
     * first-death queue the filter matches on.
     */
    targetQueue: string;
    filter: DlqReplayFilter;
    /** Without this the run is a dry run: it selects and reports, publishes nothing. */
    approve?: boolean;
    /** The confirmation value the dry run printed. Required when `approve` is set. */
    confirm?: string;
    /**
     * How long to wait for the broker to confirm one publish before giving up
     * on it. Default `DEFAULT_PUBLISH_TIMEOUT_MS`.
     */
    publishTimeoutMs?: number;
}

export interface DlqReplayResult {
    dlqQueue: string;
    targetQueue: string;
    inspection: DlqInspection;
    selection: DlqSelection;
    /** False for a dry run. */
    approved: boolean;
    /** Messages actually published, in the order they went. */
    replayed: readonly DlqMessage[];
    /** Set when a publish failed; everything after it was left alone. */
    failure: { message: DlqMessage; error: string } | null;
}

/**
 * How long one publish may wait for its confirm.
 *
 * There has to be a limit. When RabbitMQ raises a memory or disk alarm it BLOCKS
 * publishers: the connection stays up, the publish is accepted, and the confirm
 * simply never comes. Without a timeout the run hangs forever holding up to
 * `scanLimit` messages unacked — invisible to anything else reading that DLQ —
 * and the operator gets a silent CLI during exactly the kind of incident this
 * tool exists for. Timing out fails safe: the originals were never acked, so the
 * run stops with a failure the report explains and nothing is lost.
 */
export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;

/** A decoded message kept next to the bytes needed to republish it. */
interface ScannedMessage {
    message: DlqMessage;
    raw: DlqRawMessage;
}

/**
 * Read a dead-letter queue without changing it.
 *
 * Pulls up to `scanLimit` messages with `noAck: false`, decodes each one, then
 * requeues the lot. Nothing is acknowledged, so the queue is left as found.
 */
export async function inspectDeadLetterQueue(opts: DlqInspectOptions): Promise<DlqInspection> {
    const scanLimit = resolveScanLimit(opts.scanLimit);
    const open = await openChannel(opts.connectionManager, opts.logger);
    try {
        const messageCount = await checkQueueOrRefuse(open, opts.dlqQueue);
        const scan = await scanQueue(open.channel, opts.dlqQueue, scanLimit);
        const inspection = buildInspection(opts.dlqQueue, messageCount, scan);
        opts.logger.info('[DlqReplay] inspected dead-letter queue', {
            dlqQueue: opts.dlqQueue,
            queueDepth: inspection.queueDepth,
            scanned: inspection.messages.length,
            scanTruncated: inspection.scanTruncated,
        });
        return inspection;
    } finally {
        await releaseChannel(open, opts.logger);
    }
}

/**
 * Select a targeted subset of a dead-letter queue and, when approved, republish
 * each one to the caller's own queue — one at a time, stopping on the first
 * failure so a broken broker cannot turn into a partial fan-out nobody noticed.
 *
 * The filter is validated BEFORE the broker is touched, so a run that could
 * never have been safe fails without reading anybody's messages.
 */
export async function replayDeadLetters(opts: DlqReplayOptions): Promise<DlqReplayResult> {
    validateFilter(opts.filter);
    if (opts.approve && !opts.confirm) {
        throw new DlqReplayRefusedError(
            'no-confirmation',
            'Refusing to replay without a confirmation value. Run the same command without ' +
                'the approve flag first, then pass the confirmation it prints.',
        );
    }
    const scanLimit = resolveScanLimit(opts.scanLimit);

    const open = await openChannel(opts.connectionManager, opts.logger);
    // A publish to the default exchange with an unknown queue name is silently
    // dropped. `mandatory` makes the broker hand it back instead, and this
    // listener turns that into a failure rather than a message that reports as
    // sent and does not exist.
    const returned: DlqRawMessage[] = [];
    open.channel.on('return', msg => returned.push(msg));

    try {
        // Check the destination BEFORE reading anything. Doing it first means a
        // typo'd queue name fails while we hold nothing unacked — a checkQueue
        // 404 closes the channel, and a closed channel mid-scan would requeue
        // through the broker's timeout rather than our own teardown.
        await checkQueueOrRefuse(open, opts.targetQueue);
        const messageCount = await checkQueueOrRefuse(open, opts.dlqQueue);

        const scan = await scanQueue(open.channel, opts.dlqQueue, scanLimit);
        const inspection = buildInspection(opts.dlqQueue, messageCount, scan);
        const selection = selectForReplay(inspection.messages, opts.filter, opts.targetQueue);
        // Overriding the first-death queue is legitimate (a service that renamed
        // its queue still has dead letters under the old name) but it is the one
        // setting that reaches messages which are not this consumer's own. It
        // must never happen quietly: it goes in the log and at the top of the
        // report, both of which an approve is read against.
        if (selection.firstDeathQueue !== opts.targetQueue) {
            opts.logger.warn('[DlqReplay] replaying messages that died on ANOTHER queue', {
                targetQueue: opts.targetQueue,
                firstDeathQueue: selection.firstDeathQueue,
            });
        }
        logDecisions(selection.decisions, opts.logger, opts.dlqQueue);

        if (!opts.approve) {
            opts.logger.info('[DlqReplay] dry run complete', {
                dlqQueue: opts.dlqQueue,
                targetQueue: opts.targetQueue,
                scanned: inspection.messages.length,
                selected: selection.selected.length,
                confirmation: selection.confirmation,
            });
            return {
                dlqQueue: opts.dlqQueue,
                targetQueue: opts.targetQueue,
                inspection,
                selection,
                approved: false,
                replayed: [],
                failure: null,
            };
        }

        // The selection is recomputed from a fresh read of the queue, so a
        // confirmation minted against a different set — messages drained, new
        // ones arrived, a filter retyped — no longer matches, and the approve is
        // refused rather than acting on a stale report.
        if (opts.confirm !== selection.confirmation) {
            throw new DlqReplayRefusedError(
                'confirmation-mismatch',
                'Refusing to replay: the confirmation does not match what is on the queue now ' +
                    `(given ${String(opts.confirm)}, current ${selection.confirmation}). The ` +
                    'dead-letter queue has changed since the dry run. Re-run the dry run and use ' +
                    'its value.',
            );
        }
        if (selection.selected.length === 0) {
            throw new DlqReplayRefusedError(
                'nothing-selected',
                'Refusing to replay: the filter selected no messages.',
            );
        }
        // A scan that stopped early saw an arbitrary window of the queue, and
        // the dry run's window need not be this one — so the selection, and
        // therefore the confirmation, is not reproducible. Left alone this is
        // the one refusal an operator cannot clear by retrying: every attempt
        // reads a different window and mismatches again.
        if (inspection.scanTruncated) {
            throw new DlqReplayRefusedError(
                'scan-truncated',
                `Refusing to replay: the dead-letter queue has more than ${scanLimit} messages, ` +
                    'so this run only saw part of it and the selection is not reproducible. ' +
                    'Raise --scan-limit past the queue depth and run the dry run again.',
            );
        }

        const rawByPosition = new Map(scan.scanned.map(s => [s.message.position, s.raw] as const));
        const { replayed, failure } = await publishSelected(
            open.channel,
            opts,
            selection,
            rawByPosition,
            returned,
        );
        opts.logger.info('[DlqReplay] replay complete', {
            dlqQueue: opts.dlqQueue,
            targetQueue: opts.targetQueue,
            selected: selection.selected.length,
            replayed: replayed.length,
            failed: failure ? 1 : 0,
        });
        return {
            dlqQueue: opts.dlqQueue,
            targetQueue: opts.targetQueue,
            inspection,
            selection,
            approved: true,
            replayed,
            failure,
        };
    } finally {
        // Requeues everything the scan read, replayed or not. The originals stay
        // on the DLQ by design — see the module header.
        await releaseChannel(open, opts.logger);
    }
}

/** Human-readable report for an inspection. */
export function formatInspectionReport(inspection: DlqInspection): string {
    const lines: string[] = [];
    lines.push(`Dead-letter queue: ${inspection.dlqQueue}`);
    lines.push(`Depth reported by the broker: ${inspection.queueDepth}`);
    lines.push(`Messages read: ${inspection.messages.length}`);
    if (inspection.scanTruncated) {
        lines.push('NOTE: the scan limit was reached — there may be more. Raise --scan-limit.');
    }
    lines.push('');
    lines.push('Grouped by first-death queue, routing key and death minute:');
    if (inspection.groups.length === 0) lines.push('  (nothing on the queue)');
    for (const group of inspection.groups) {
        lines.push(
            `  ${String(group.count).padStart(5)}  ${group.firstDeathQueue}  ` +
                `${group.routingKey}  ${group.deadLetteredAtMinute}`,
        );
    }
    lines.push('');
    lines.push('Messages:');
    for (const message of inspection.messages) lines.push(`  ${describeLine(message)}`);
    lines.push('');
    lines.push(UNTOUCHED_NOTE);
    return lines.join('\n');
}

/** Human-readable report for a dry run or an approved replay. */
export function formatReplayReport(result: DlqReplayResult): string {
    const lines: string[] = [];
    lines.push(`Dead-letter queue: ${result.dlqQueue}`);
    lines.push(`Replaying into:    ${result.targetQueue}`);
    lines.push(`First-death queue: ${result.selection.firstDeathQueue}`);
    if (result.selection.firstDeathQueue !== result.targetQueue) {
        lines.push(
            '  ⚠ NOT this consumer’s own queue. These messages died on another ' +
                'service’s queue and would be delivered to yours. Only do this if you ' +
                'know why — normally the first-death queue is left alone.',
        );
    }
    lines.push(`Messages read:     ${result.inspection.messages.length}`);
    if (result.inspection.scanTruncated) {
        lines.push('NOTE: the scan limit was reached — there may be more. Raise --scan-limit.');
    }
    lines.push(`Selected:          ${result.selection.selected.length}`);
    lines.push('');

    const skipped = result.selection.decisions.filter(d => !d.selected);
    if (skipped.length > 0) {
        lines.push('Skipped:');
        const counts = new Map<string, number>();
        for (const decision of skipped) {
            const reason = decision.reason ?? 'unknown';
            counts.set(reason, (counts.get(reason) ?? 0) + 1);
        }
        for (const [reason, count] of [...counts].sort((a, b) => b[1] - a[1])) {
            lines.push(`  ${String(count).padStart(5)}  ${reason}`);
        }
        lines.push('');
    }

    lines.push(result.approved ? 'Replayed:' : 'Would replay:');
    if (result.selection.selected.length === 0) lines.push('  (nothing matched the filter)');
    // Keyed on position rather than object identity: position is unique within
    // a scan, and the report should not quietly mislabel everything if a future
    // change ever copies a message instead of passing the same object through.
    const sent = new Set(result.replayed.map(m => m.position));
    for (const message of result.selection.selected) {
        const mark = result.approved
            ? sent.has(message.position)
                ? 'sent    '
                : 'NOT SENT'
            : 'would   ';
        lines.push(`  ${mark}  ${describeLine(message)}`);
    }
    lines.push('');

    if (result.failure) {
        lines.push(
            `FAILED on ${result.failure.message.eventId ?? '(no event id)'}: ${result.failure.error}`,
        );
        lines.push('Stopped there. Nothing after it was published. Nothing was lost.');
        lines.push('');
    }
    if (!result.approved) {
        lines.push(
            'Dry run — nothing was published. To do it, re-run with ' +
                `--approve --confirm ${result.selection.confirmation}`,
        );
        lines.push('');
    }
    lines.push(UNTOUCHED_NOTE);
    return lines.join('\n');
}

const UNTOUCHED_NOTE =
    'The dead-letter queue is untouched: nothing was acknowledged or removed, and a replay ' +
    'publishes a COPY. Emptying the dead-letter queue remains a broker-admin action and is ' +
    'deliberately not something this tool can do.';

// ─── internals ───────────────────────────────────────────────────────────

function buildInspection(
    dlqQueue: string,
    queueDepth: number,
    scan: { scanned: readonly ScannedMessage[]; truncated: boolean },
): DlqInspection {
    const messages = scan.scanned.map(s => s.message);
    return {
        dlqQueue,
        queueDepth,
        messages,
        groups: groupDlqMessages(messages),
        scanTruncated: scan.truncated,
    };
}

function describeLine(message: DlqMessage): string {
    return [
        `#${String(message.position).padStart(4)}`,
        message.eventId ?? '(unparseable envelope)',
        message.eventType ? `${message.eventType}.v${String(message.eventVersion)}` : '-',
        message.aggregateId ? `${message.aggregateType}/${message.aggregateId}` : '-',
        `died=${message.deadLetteredAt?.toISOString() ?? '(no death time)'}`,
        `from=${message.firstDeathQueue ?? '(unknown)'}`,
        `reason=${message.firstDeathReason ?? '(unknown)'}`,
        // A message on its 5th death is a different problem from one on its
        // 1st, and it is the cheapest signal that a replay already failed.
        `deaths=${String(message.deathCount)}`,
    ].join('  ');
}

function resolveScanLimit(requested: number | undefined): number {
    const scanLimit = requested ?? DEFAULT_SCAN_LIMIT;
    if (!Number.isInteger(scanLimit) || scanLimit < 1 || scanLimit > SCAN_LIMIT_CEILING) {
        throw new DlqReplayRefusedError(
            'bad-scan-limit',
            `Scan limit must be a whole number between 1 and ${SCAN_LIMIT_CEILING} ` +
                `(got ${String(requested)}).`,
        );
    }
    return scanLimit;
}

/** An open channel plus the two bits of state its own events carry. */
interface OpenChannel {
    channel: DlqChannel;
    /** True once the broker or the client has closed it. */
    isClosed(): boolean;
    /** The channel-level error the broker reported, if any. */
    error(): Error | null;
}

/**
 * Open a confirm channel and, crucially, LISTEN FOR ITS 'error' EVENT.
 *
 * A channel-level error — the likeliest being a 404 from `checkQueue` on a
 * mistyped queue name — makes amqplib `emit('error')` before it rejects the
 * pending RPC. An EventEmitter 'error' with no listener is thrown, so without
 * this the typo crashes the whole process AND the throw escapes before amqplib
 * reaches the code that rejects the promise, leaving the caller awaiting
 * forever. (Found by the integration test; `EventConsumer.setupChannel` guards
 * the same way, for the same reason.)
 *
 * Keeping the error here also lets `checkQueueOrRefuse` report what the broker
 * actually said instead of amqplib's generic "no reply will be forthcoming".
 */
async function openChannel(source: DlqChannelSource, logger: ILogger): Promise<OpenChannel> {
    // Mirrors EventConsumer.setupChannel: older soa-rabbitmq builds predate
    // ensureConnected(), and a fake in a unit test has no reason to implement it.
    if (typeof source.ensureConnected === 'function') await source.ensureConnected();
    const channel = await source.newConfirmChannel();
    let closed = false;
    let channelError: Error | null = null;
    channel.on('error', (err: unknown) => {
        channelError = toError(err);
        logger.warn('[DlqReplay] channel error', { error: channelError.message });
    });
    channel.on('close', () => {
        closed = true;
    });
    return { channel, isClosed: () => closed, error: () => channelError };
}

/**
 * `checkQueue` on a queue that does not exist kills the channel. Translate that
 * into a refusal carrying the broker's own words, so an operator sees "no queue
 * 'coach-api.instance-creaton'" and fixes the typo.
 */
async function checkQueueOrRefuse(open: OpenChannel, queue: string): Promise<number> {
    try {
        const { messageCount } = await open.channel.checkQueue(queue);
        return messageCount;
    } catch (err) {
        const cause = open.error() ?? toError(err);
        throw new DlqReplayRefusedError(
            'queue-unavailable',
            `Cannot use queue "${queue}": ${cause.message}`,
        );
    }
}

/**
 * Requeue everything read, then close. Closing alone would requeue too (the
 * broker returns unacked messages when a channel dies), but doing it explicitly
 * puts the intent in the code rather than in a broker behaviour the reader has
 * to already know. Failures here are logged, never thrown: the run's result
 * matters more than a tidy teardown, and the broker requeues regardless.
 */
async function releaseChannel(open: OpenChannel, logger: ILogger): Promise<void> {
    // A channel the broker already killed has requeued everything itself, and
    // both calls below would only throw IllegalOperationError.
    if (open.isClosed()) return;
    try {
        open.channel.nackAll(true);
    } catch (err) {
        logger.warn('[DlqReplay] could not requeue explicitly; the channel close will do it', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    try {
        await open.channel.close();
    } catch {
        // Raced a close from the broker side; the requeue happens regardless.
    }
}

/**
 * Pull messages off the queue with `noAck: false` and hold them unacked.
 *
 * Holding them is what makes the walk work: `basic.get` skips messages already
 * delivered-and-unacked on this channel, so successive calls advance through
 * the queue instead of handing back the same head message forever.
 */
async function scanQueue(
    channel: DlqChannel,
    dlqQueue: string,
    scanLimit: number,
): Promise<{ scanned: ScannedMessage[]; truncated: boolean }> {
    const scanned: ScannedMessage[] = [];
    // `truncated` is "we stopped early", which is NOT the same as "we read
    // scanLimit messages": a queue holding exactly scanLimit is fully read. The
    // only proof there is nothing left is a `get` that returns false, so the
    // loop runs one extra time to ask.
    let truncated = true;
    for (let position = 1; position <= scanLimit + 1; position++) {
        const raw = await channel.get(dlqQueue, { noAck: false });
        if (raw === false) {
            truncated = false;
            break;
        }
        if (position > scanLimit) {
            // One past the limit: this message proves there is more, and it is
            // deliberately not added to the scan. It goes back with the rest.
            break;
        }
        scanned.push({
            message: describeDlqMessage(
                position,
                raw.content,
                raw.properties.headers,
                raw.fields.routingKey,
            ),
            raw,
        });
    }
    return { scanned, truncated };
}

function logDecisions(decisions: readonly DlqDecision[], logger: ILogger, dlqQueue: string): void {
    for (const decision of decisions) {
        // Debug, not info: on a deep DLQ this is one line per message, and the
        // operator's copy of the same information is the printed report.
        logger.debug('[DlqReplay] decision', {
            dlqQueue,
            position: decision.message.position,
            eventId: decision.message.eventId,
            eventType: decision.message.eventType,
            selected: decision.selected,
            reason: decision.reason,
        });
    }
}

/**
 * Publish the selected messages one at a time, confirming each before starting
 * the next, and stop on the first failure.
 *
 * Serial rather than batched on purpose: a recovery run is small, and "the
 * first four went, the fifth failed, the rest were left alone" is a state an
 * operator can reason about. A pipelined batch that half-confirms is not.
 */
async function publishSelected(
    channel: DlqChannel,
    opts: DlqReplayOptions,
    selection: DlqSelection,
    rawByPosition: ReadonlyMap<number, DlqRawMessage>,
    returned: readonly DlqRawMessage[],
): Promise<{ replayed: DlqMessage[]; failure: { message: DlqMessage; error: string } | null }> {
    const replayedAt = new Date().toISOString();
    const replayed: DlqMessage[] = [];

    for (const message of selection.selected) {
        const raw = rawByPosition.get(message.position);
        if (!raw) {
            // Cannot happen — the selection is built from the same scan — but a
            // silent skip here would be a message reported as replayed that
            // never was, so it stops the run like any other failure.
            return {
                replayed,
                failure: { message, error: 'internal: no raw message for this position' },
            };
        }
        const returnedBefore = returned.length;
        try {
            await publishOne(channel, opts, raw, message, replayedAt);
            // Correlate an unroutable return to THIS message by its body rather
            // than by "something arrived since". RabbitMQ sends basic.return
            // before basic.ack for the same publish, so position would almost
            // always work — but "almost always" here means mislabelling a good
            // publish as failed and a failed one as sent, which is the one thing
            // the report must never get wrong.
            const mine = returned
                .slice(returnedBefore)
                .some(returnedMsg => returnedMsg.content.equals(raw.content));
            if (mine) {
                return {
                    replayed,
                    failure: {
                        message,
                        error:
                            `the broker returned the message as unroutable — queue ` +
                            `"${opts.targetQueue}" did not accept it`,
                    },
                };
            }
        } catch (err) {
            return {
                replayed,
                failure: { message, error: err instanceof Error ? err.message : String(err) },
            };
        }
        replayed.push(message);
        opts.logger.info('[DlqReplay] replayed', {
            dlqQueue: opts.dlqQueue,
            targetQueue: opts.targetQueue,
            eventId: message.eventId,
            eventType: message.eventType,
            aggregateId: message.aggregateId,
        });
    }
    return { replayed, failure: null };
}

/** One confirmed publish to the default exchange, keyed by the target queue name. */
async function publishOne(
    channel: DlqChannel,
    opts: DlqReplayOptions,
    raw: DlqRawMessage,
    message: DlqMessage,
    replayedAt: string,
): Promise<void> {
    const timeoutMs = opts.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    await withTimeout(
        timeoutMs,
        `the broker did not confirm the publish within ${timeoutMs}ms (it may be blocking ` +
            'publishers under a memory or disk alarm)',
        new Promise<void>((resolve, reject) => {
            channel.publish(
                '',
                opts.targetQueue,
                raw.content,
                {
                    ...copyProperties(raw.properties),
                    headers: replayHeaders(raw, opts.dlqQueue, message, replayedAt),
                    persistent: true,
                    // Ask the broker to hand the message back rather than drop
                    // it if the queue vanished between checkQueue and now.
                    mandatory: true,
                },
                (err: unknown) => (err ? reject(toError(err)) : resolve()),
            );
        }),
    );
    // The callback above already carries the broker's verdict, so this adds no
    // information — but requiring `waitForConfirms` in the DlqChannel type is
    // what stops a plain (non-confirm) Channel being passed in. A plain channel
    // accepts the same publish() call and simply ignores the callback, so every
    // message would report as sent without the broker ever confirming one.
    await withTimeout(
        timeoutMs,
        `the broker did not flush confirms within ${timeoutMs}ms`,
        channel.waitForConfirms(),
    );
}

/**
 * Reject with a readable message if `work` has not settled in time. The timer is
 * unref'd so a pending one cannot by itself keep a finished CLI alive, and
 * cleared either way so a long run does not accumulate them.
 */
async function withTimeout<T>(ms: number, detail: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(detail)), ms);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Carry the original AMQP properties across so the copy is byte-for-byte the
 * message the consumer would have seen. `deliveryMode` is not copied: the
 * publish sets `persistent` itself, because a dead letter that was transient is
 * still worth making durable on the way back in.
 */
function copyProperties(properties: DlqRawMessage['properties']): Record<string, unknown> {
    const copied: Record<string, unknown> = {};
    for (const key of [
        'contentType',
        'contentEncoding',
        'correlationId',
        'messageId',
        'timestamp',
        'type',
        'appId',
    ] as const) {
        const value = properties[key];
        if (value !== undefined && value !== null) copied[key] = value;
    }
    return copied;
}

/**
 * Headers for the copy: everything the original carried, MINUS the broker's
 * death bookkeeping, PLUS a note of where this copy came from.
 *
 * Dropping the death headers matters. If the replayed copy fails again, the
 * broker writes a FRESH death record naming the target queue, which is what a
 * follow-up targeted replay needs to match on. Keeping the old chain would
 * leave `x-first-death-queue` pointing at the original queue forever and
 * quietly break the "only my own messages" guard on the second attempt.
 *
 * All three families go: `x-death` itself, `x-first-death-*`, and the
 * `x-last-death-*` trio RabbitMQ 3.13 added. The last one is only informational
 * — the broker rewrites it on the next death — but leaving a stale copy of it
 * on a replayed message is exactly the sort of thing someone reads off a
 * management UI and believes.
 */
function replayHeaders(
    raw: DlqRawMessage,
    dlqQueue: string,
    message: DlqMessage,
    replayedAt: string,
): Record<string, unknown> {
    const headers: Record<string, unknown> = { ...(raw.properties.headers ?? {}) };
    for (const key of Object.keys(headers)) {
        if (
            key === 'x-death' ||
            key.startsWith('x-first-death') ||
            key.startsWith('x-last-death')
        ) {
            delete headers[key];
        }
    }
    headers[REPLAY_SOURCE_HEADER] = dlqQueue;
    headers[REPLAY_AT_HEADER] = replayedAt;
    if (message.firstDeathQueue) headers[REPLAY_DEATH_QUEUE_HEADER] = message.firstDeathQueue;
    return headers;
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}
