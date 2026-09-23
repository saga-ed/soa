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
//     nothing — and NOTHING HERE MAY DEPEND ON THAT ORDER, because the dry run
//     reshuffles the queue for the approve that follows it. Which messages are
//     selected, which order they are published in, and the confirmation digest
//     are all derived from the messages themselves (see `selectForReplay` and
//     `computeConfirmation`), never from where they happened to sit.
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
    countSkipReasons,
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
 * each one to the caller's own queue — oldest first, one at a time, stopping on
 * the first failure so a broken broker cannot turn into a partial fan-out nobody
 * noticed.
 *
 * The filter is validated BEFORE the broker is touched, so a run that could
 * never have been safe fails without reading anybody's messages.
 *
 * An approved run then passes three refusals, in an order chosen so that the one
 * that fires is the one an operator can act on: `scan-truncated`, then
 * `nothing-selected`, then `confirmation-mismatch`. The comment at that point in
 * the body has the reasoning; it is not arbitrary and swapping two of them
 * reintroduces a refusal that cannot be cleared by retrying.
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
            // The confirmation is deliberately NOT logged. Its whole job is to
            // make an approve follow a report somebody read, and a value sitting
            // in CloudWatch or Datadog is a way to approve without ever having
            // opened one. The printed report is the only place it appears.
            opts.logger.info('[DlqReplay] dry run complete', {
                dlqQueue: opts.dlqQueue,
                targetQueue: opts.targetQueue,
                scanned: inspection.messages.length,
                selected: selection.selected.length,
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

        // THE ORDER OF THE THREE REFUSALS BELOW IS LOAD-BEARING, and the rule
        // behind it is: every refusal this tool emits has to tell the operator
        // something they can act on. Being merely true is not enough — the
        // refusal that fires must be the one that explains what they are
        // actually looking at.
        //
        // 1. scan-truncated. A partial scan makes the confirmation meaningless:
        //    each run reads a different window of the queue and mints a
        //    different digest from it. Checked FIRST because otherwise the
        //    mismatch below fires on every attempt, tells the operator the queue
        //    changed when nothing has, and cannot be cleared by retrying — the
        //    one refusal a retry can never resolve, hiding the one refusal that
        //    says what to do about it.
        // 2. nothing-selected. Once the window is not in doubt, an empty
        //    selection is a complete statement of fact that needs no dry run to
        //    interpret, and it comes with the skip counts that explain it. It
        //    cannot publish anything either way, so checking it ahead of the
        //    confirmation weakens nothing — and when both are true, "the filter
        //    selected no messages" is the more useful of the two.
        // 3. confirmation-mismatch. Only meaningful once the selection is both
        //    reproducible and non-empty. It stays last and unconditional: it is
        //    the guard every publish passes through.
        if (!confirmationIsReproducible(inspection, selection)) {
            throw new DlqReplayRefusedError(
                'scan-truncated',
                describeTruncatedScan(inspection, selection, scanLimit),
            );
        }
        if (selection.selected.length === 0) {
            throw new DlqReplayRefusedError(
                'nothing-selected',
                'Refusing to replay: the filter selected no messages. ' +
                    `${describeSkips(selection)} Nothing was published. Re-run without ` +
                    '--approve for the full report, or use --inspect to see what is on the queue.',
            );
        }
        // The selection is recomputed from a fresh read of the queue, so a
        // confirmation minted against a different set — messages drained, new
        // ones arrived, a filter retyped — no longer matches, and the approve is
        // refused rather than acting on a stale report.
        //
        // The current value is NOT printed back. Handing it over would let
        // `--approve --confirm anything` fetch the real one and a second command
        // publish, with nobody having read a dry-run report — which is the only
        // thing the confirmation step is for. Echoing what the operator supplied
        // is fine; it is what they already have in front of them.
        if (opts.confirm !== selection.confirmation) {
            throw new DlqReplayRefusedError(
                'confirmation-mismatch',
                `Refusing to replay: the confirmation "${String(opts.confirm)}" does not ` +
                    'describe what this run selected. Re-run the same command without ' +
                    '--approve and use the confirmation at the bottom of that report — it is ' +
                    'printed there and nowhere else, so that an approve always follows a report ' +
                    'somebody has read. If that value came from an earlier dry run, the queue ' +
                    'or the filter has changed since, and the new report shows what is selected ' +
                    'now.',
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
        lines.push(
            `${truncationNote(inspection)} Raise --scan-limit (ceiling ${SCAN_LIMIT_CEILING}) ` +
                'to see more.',
        );
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
        lines.push(truncationNote(result.inspection));
        // Say now whether the approve will be accepted, rather than letting the
        // operator find out by typing it. Read off the SAME predicate the guard
        // uses, so the report cannot promise something the approve then refuses.
        lines.push(
            confirmationIsReproducible(result.inspection, result.selection)
                ? '  Every event id named with --event-id was selected, once each, so this ' +
                  'selection is the same in any run that gets this far, and an approve is ' +
                  'allowed.'
                : '  An approve will be REFUSED while this is true: each run reads a different ' +
                  'part and selects a different set. Raise --scan-limit (ceiling ' +
                  `${SCAN_LIMIT_CEILING}) past the queue depth, or name the messages with ` +
                  '--event-id.',
        );
    }
    lines.push(`Selected:          ${result.selection.selected.length}`);
    lines.push('');

    const counts = countSkipReasons(result.selection.decisions);
    if (counts.length > 0) {
        lines.push('Skipped:');
        for (const [reason, count] of counts) {
            lines.push(`  ${String(count).padStart(5)}  ${reason}`);
        }
        // A cap that bit is not a skip like the others: those messages matched
        // everything, and nothing about them will change on a re-run. Say what
        // to do instead of leaving an `over-max` count to be puzzled over.
        const overMax = counts.find(([reason]) => reason === 'over-max')?.[1];
        if (overMax !== undefined) {
            lines.push(
                `  ${overMax} more matched than --max allows. The originals stay on the ` +
                    'dead-letter queue, so running this again replays the SAME oldest batch, ' +
                    'not the next one. Raise --max, or move --since past the batch below.',
            );
        }
        lines.push('');
    }

    // Say what the order is. The list is sorted by death time then event id, not
    // by the `#position` each message came off the queue at, so the positions
    // read out of sequence — which looks like a bug unless the header says
    // otherwise. (Within one second every death time is equal, because `x-death`
    // records whole seconds, so a burst sorts by event id and looks arbitrary.)
    lines.push(
        result.approved ? 'Replayed (oldest first):' : 'Would replay, in this order (oldest first):',
    );
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

/**
 * How much of the queue a truncated run actually read. Shared so the inspect
 * report and the replay report cannot end up describing the same queue
 * differently — each adds its own advice after it.
 */
function truncationNote(inspection: DlqInspection): string {
    return (
        `NOTE: the scan limit was reached — this is ${inspection.messages.length} of the ` +
        `${inspection.queueDepth} messages on the queue, not all of it.`
    );
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
                `(got ${String(requested)}). The ceiling bounds what one run holds unacked, ` +
                'on this side and on the broker, during exactly the incident that made the ' +
                'queue deep. A queue deeper than that cannot be taken in whole: name the ' +
                'messages you need with --event-id instead — see the refusal a truncated ' +
                'scan prints.',
        );
    }
    return scanLimit;
}

/**
 * Why a truncated scan is being refused, and what the operator can do about it.
 *
 * "Raise --scan-limit past the queue depth" on its own is advice that runs out:
 * the ceiling is `SCAN_LIMIT_CEILING`, and a dead-letter queue deeper than that
 * is entirely plausible in the kind of incident this tool is for. So the message
 * names the depth it is up against, offers the raise only when a raise would
 * actually reach, and otherwise points at `--event-id`, which is reproducible at
 * any depth (see `DlqSelection.windowIndependent`). When ids WERE named, it says
 * which of them this window could not account for — that is the fact the
 * operator needs and the one they cannot get any other way.
 */
function describeTruncatedScan(
    inspection: DlqInspection,
    selection: DlqSelection,
    scanLimit: number,
): string {
    const parts = [
        `Refusing to replay: this run read ${inspection.messages.length} messages of the ` +
            `${inspection.queueDepth} the broker reports on "${inspection.dlqQueue}", so it saw ` +
            'only part of the queue. Another run reads a different part and selects a ' +
            'different set, so the confirmation cannot be reproduced and this cannot be ' +
            'approved as it stands.',
    ];

    // Rendered from the coverage the SELECTION already worked out, never
    // re-derived here — see `describeNamedIdCoverage`. A refusal that disagreed
    // with the rule that raised it would be worse than no detail at all.
    const { notFound, readButSkipped, duplicated } = selection.namedIdCoverage;
    if (notFound.length > 0) {
        parts.push(`Not in the part of the queue this run saw: ${notFound.join(', ')}.`);
    }
    if (readButSkipped.length > 0) {
        // Not a truncation problem at all, but it is what is keeping the run
        // from the --event-id path, so it belongs in the same message.
        parts.push(
            'Read, but skipped by another rule (--max, the event-type allowlist, the ' +
                `first-death-queue guard, an unparseable body): ${readButSkipped.join(', ')}. ` +
                'The dry-run report gives the reason for each.',
        );
    }
    if (duplicated.length > 0) {
        // This tool makes these itself: a replayed copy that fails again
        // dead-letters next to the original under the same event id.
        parts.push(
            'On this queue more than once, so a partial scan cannot tell how many copies ' +
                `there are: ${duplicated.join(', ')}.`,
        );
    }

    // A scan can be truncated with a depth at or under the limit — messages
    // arriving mid-scan — so ask for one past what this run actually read.
    const needed = Math.max(inspection.queueDepth, scanLimit + 1);
    parts.push(
        needed > SCAN_LIMIT_CEILING
            ? `This queue is past the ${SCAN_LIMIT_CEILING}-message scan ceiling, so no run ` +
              'can take all of it in and raising --scan-limit will not help.'
            : `One way is to raise --scan-limit to at least ${needed} (it is ${scanLimit}, the ` +
              `ceiling is ${SCAN_LIMIT_CEILING}) and run the dry run again.`,
    );
    parts.push(NAME_THE_IDS_ADVICE);
    parts.push(
        needed > SCAN_LIMIT_CEILING
            ? 'If they are not in the part a scan can reach, they are past what a targeted ' +
              'replay can do — that is a broker-admin drain or a purpose-built backfill, not ' +
              'this tool.'
            : '--inspect lists what is there.',
    );
    return parts.join(' ');
}

/**
 * The one way through a queue too deep to scan, worded once. Both arms of the
 * refusal above offer it, and rewording it in only one of them is how the two
 * halves of a refusal start telling an operator different things.
 */
const NAME_THE_IDS_ADVICE =
    'Name the messages you need with --event-id: a run that selects exactly the ids it was ' +
    'given, one copy each, picks the same set whatever else is on the queue, and is allowed ' +
    'through.';

/** The skip counts that explain an empty selection, for a refusal that prints no report. */
function describeSkips(selection: DlqSelection): string {
    const counts = countSkipReasons(selection.decisions);
    if (selection.decisions.length === 0) {
        return 'Nothing was read off the dead-letter queue at all.';
    }
    const summary = counts.map(([reason, count]) => `${count} ${reason}`).join(', ');
    return `The ${selection.decisions.length} messages read were skipped as: ${summary}.`;
}

/**
 * Can another run reproduce this run's confirmation?
 *
 * The one predicate behind both the `scan-truncated` refusal and the note the
 * dry-run report prints about it. Those two must agree — the report's whole job
 * is to say in advance what the approve will do — and the way to guarantee that
 * is for there to be one of them, not two expressions that have to be kept in
 * step. A third reason a run might not be reproducible belongs here, once.
 */
function confirmationIsReproducible(inspection: DlqInspection, selection: DlqSelection): boolean {
    // A scan that reached the end saw the whole queue: any two runs over the
    // same messages select the same set, whatever order they came off in.
    if (!inspection.scanTruncated) return true;
    // A partial scan only agrees with another partial scan when the selection is
    // pinned to ids the operator named — see `DlqNamedIdCoverage`.
    return selection.namedIdCoverage.complete;
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
 *
 * `selection.selected` arrives ordered oldest death first, so a run that stops
 * half way has replayed a prefix in time rather than an arbitrary handful.
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
