// Targeted dead-letter inspection + replay — the pure half.
//
// WHAT THIS IS FOR: when a consumer dead-letters a handful of messages for a
// reason that has since been fixed (a deploy overlap, a deadlock, a transient
// dependency outage), somebody has to put those messages back. Doing that
// through the RabbitMQ management UI needs the broker admin credential and
// network reach into the VPC, which almost nobody has. This module lets a
// service do it with its OWN broker user over plain AMQP: no management HTTP
// API, no admin secret.
//
// WHY REPLAY IS SAFE FOR THE CONSUMER: `EventConsumer.processEnvelope` inserts
// `(consumer_name, event_id)` into `consumed_events` in the SAME transaction as
// the handler's projection write, and both commit or both roll back. So:
//   - An event the consumer already processed has a committed row. A replayed
//     copy hits `ON CONFLICT DO NOTHING`, inserts nothing, and is acked without
//     running the handler. Redelivering it is a no-op, not a double-apply.
//   - An event that FAILED has no row (the insert rolled back with the handler).
//     A replayed copy runs the handler as if it were new.
// That is the whole reason a blunt "put it back" is acceptable here.
//
// WHAT IS *NOT* SAFE TO REPLAY GENERICALLY: events that REPLACE a whole
// projection rather than amend it — a persona's full permission set, a full
// policy set, "here is the complete list of X for aggregate Y". If a newer one
// of those already landed, replaying the older one rewinds the projection to a
// stale snapshot, and `consumed_events` will not stop it: the old event has its
// own event id and has never been processed, so it looks brand new. The
// `consumed_events` table gives at-most-once-per-event, NOT ordering.
// This module deliberately does NOT try to guess which types those are —
// guessing wrong is silent data corruption. Instead `eventTypes` is a
// MANDATORY-in-practice caller-supplied allowlist: the service that owns the
// handlers names the types it is willing to have re-run, and everything else is
// skipped. See `selectForReplay`.
//
// SHARED DLQ: several services dead-letter into one queue (e.g. every consumer
// of `iam.events` shares `iam.events.dlq.queue`), and a service's broker user
// can technically read all of it. Every filter therefore runs BEFORE anything
// is published, and `firstDeathQueue` defaults to the caller's own target queue
// so the default behaviour is "only my own messages". A message whose first
// death was some other service's queue is never republished — republishing it
// to our queue would hand us an event our handlers may not even have, and
// republishing it to THEIRS is not ours to do. (`firstDeathQueue` CAN be
// overridden, for a service that renamed its own queue. The runner warns and
// prints a banner whenever it is not the target queue, because that is the one
// setting which reaches messages that are not the caller's own.)
//
// IDENTIFIERS ONLY, NEVER PAYLOADS. Inspecting a shared DLQ means decoding
// other services' messages, so nothing here prints or logs `envelope.payload` —
// only the envelope's identifiers (event id, type, version, aggregate type and
// id) and the broker's own death bookkeeping. Those are the same fields
// `EventConsumer` already puts on its spans. A payload can carry anything a
// publisher chose to put in it, and a recovery report ends up in CloudWatch and
// Datadog.

import { createHash } from 'node:crypto';
import { EventEnvelopeSchema, type EventEnvelope } from '@saga-ed/soa-event-envelope';

/** Conservative default for how many messages one replay may publish. */
export const DEFAULT_MAX_MESSAGES = 25;

/**
 * Hard ceiling on `maxMessages`. Not a tuning knob — a replay bigger than this
 * is a backfill, and a backfill belongs in a purpose-built job that can be
 * paused and resumed, not in a recovery tool that stops on the first failure.
 */
export const MAX_MESSAGES_CEILING = 500;

/** Default number of messages to pull off the DLQ while inspecting. */
export const DEFAULT_SCAN_LIMIT = 1_000;

/** Hard ceiling on `scanLimit` — bounds how much we hold in memory at once. */
export const SCAN_LIMIT_CEILING = 10_000;

/**
 * Header stamped on every republished copy with the DLQ it came from, so a
 * later inspection can tell a replay from an original at a glance.
 */
export const REPLAY_SOURCE_HEADER = 'x-saga-replayed-from';
/** Header stamped with the ISO time of the replay run. */
export const REPLAY_AT_HEADER = 'x-saga-replayed-at';
/** Header stamped with the queue the message first died on. */
export const REPLAY_DEATH_QUEUE_HEADER = 'x-saga-replay-first-death-queue';

/**
 * Thrown for every refusal: a filter that does not target anything, a count
 * over the ceiling, a confirmation that does not match the current selection.
 * A single type so callers can map "refused" to its own exit code without
 * having to distinguish it from a broker error.
 */
export class DlqReplayRefusedError extends Error {
    constructor(
        public readonly reason: string,
        detail: string,
    ) {
        super(detail);
        this.name = 'DlqReplayRefusedError';
    }
}

/**
 * Which dead letters a run is allowed to touch.
 *
 * TARGETING IS MANDATORY. At least one of `eventTypes`, `eventIds` or a time
 * bound must be supplied — see `validateFilter`. `firstDeathQueue` does not
 * count (it defaults to the target queue, so it is always set and could never
 * refuse anything), and neither does `maxMessages` (a cap bounds the blast
 * radius, it does not say what you meant to select).
 */
export interface DlqReplayFilter {
    /**
     * Only messages whose FIRST death was this queue. Defaults to the target
     * queue, i.e. "only messages that died on the queue I am replaying into".
     * Passing something else is how a service replays a message that died on a
     * queue it has since renamed; it is never a way to move another service's
     * messages, because the publish still goes to the caller's own queue.
     */
    firstDeathQueue?: string;
    /**
     * Event types the caller is willing to re-run, matched exactly against
     * `envelope.eventType`. This is where the "safe to replay?" judgement
     * lives — see the module header.
     */
    eventTypes?: readonly string[];
    /** Only messages dead-lettered at or after this instant. */
    deadLetteredAfter?: Date;
    /** Only messages dead-lettered at or before this instant. */
    deadLetteredBefore?: Date;
    /** Only these event ids. The narrowest filter there is. */
    eventIds?: readonly string[];
    /**
     * Select at most this many messages: the oldest that many, by death time.
     * Defaults to `DEFAULT_MAX_MESSAGES`; capped at `MAX_MESSAGES_CEILING`.
     *
     * Note what a second run does NOT do. Nothing is ever acked, so the
     * originals are still on the dead-letter queue afterwards and re-running the
     * same command selects the SAME oldest batch again. To reach the rest, raise
     * this or move the `deadLetteredAfter` bound past the batch just replayed —
     * which is why the cap takes the oldest rather than an arbitrary handful.
     */
    maxMessages?: number;
}

/** Why a message on the DLQ was not selected. One per message, for the report. */
export type DlqSkipReason =
    | 'not-target-queue'
    | 'event-type-not-allowed'
    | 'event-id-not-listed'
    | 'outside-time-window'
    | 'unknown-death-time'
    | 'unparseable-envelope'
    | 'over-max';

/** One message read off the DLQ, decoded as far as it can be. */
export interface DlqMessage {
    /** 1-based order in which this message came off the queue. */
    position: number;
    /** Envelope fields, null when the body is not a parseable envelope. */
    eventId: string | null;
    eventType: string | null;
    eventVersion: number | null;
    aggregateType: string | null;
    aggregateId: string | null;
    /** From `x-first-death-queue`, falling back to the oldest `x-death` entry. */
    firstDeathQueue: string | null;
    /** From `x-first-death-reason` — `rejected`, `expired`, `maxlen`. */
    firstDeathReason: string | null;
    /** The routing key the message was originally published with. */
    routingKey: string;
    /** When it MOST RECENTLY died, from `x-death[0].time`. Null if absent. */
    deadLetteredAt: Date | null;
    /** How many times it has died, from `x-death[0].count`. */
    deathCount: number;
}

/** A message plus the decision made about it. */
export interface DlqDecision {
    message: DlqMessage;
    selected: boolean;
    /** Null when selected. */
    reason: DlqSkipReason | null;
}

/** The outcome of applying a filter to everything read off the DLQ. */
export interface DlqSelection {
    targetQueue: string;
    firstDeathQueue: string;
    decisions: readonly DlqDecision[];
    selected: readonly DlqMessage[];
    /**
     * Short digest of exactly what is selected. A replay must quote the value
     * its dry run printed, and is refused if the queue has moved on since.
     */
    confirmation: string;
    /**
     * How completely this run accounted for the event ids the filter named —
     * and, when it did not, exactly which ids are why.
     */
    namedIdCoverage: DlqNamedIdCoverage;
}

/**
 * Whether a selection is pinned to the event ids the operator typed, plus the
 * evidence for the answer.
 *
 * WHY THIS EXISTS. A scan that stops early sees an arbitrary part of the queue,
 * so in general the selection — and the `confirmation` over it — differs from
 * run to run and an approve could never be confirmed. There is one case where
 * that is not so: the filter named `eventIds` and every one of them was
 * SELECTED EXACTLY ONCE. The selected set is then the list the operator typed,
 * one message per id, and `computeConfirmation` hashes the target queue, the
 * first-death queue and that same sorted list of ids — identical in any run that
 * gets this far. `replayDeadLetters` uses that to let a targeted replay through
 * on a queue too deep to scan whole.
 *
 * Say the guarantee precisely, because the loose version is not true: any two
 * runs that are ALLOWED THROUGH select the same messages and mint the same
 * confirmation. A run that happens to see a second copy of a named id does not
 * quietly select something different — it refuses, and names the id. So the
 * outcomes are "same answer" or "a refusal that says why", never "a different
 * answer that looks the same".
 *
 * Both halves are load-bearing. A missing id means a copy of it may be sitting
 * outside the part of the queue this run read, so a wider run would select more.
 * A duplicate means the queue holds more than one copy — which this tool creates
 * itself, because a replayed copy that fails again dead-letters alongside the
 * original — and then one run could hash one copy and another two.
 *
 * This is NOT a licence to skip the confirmation. The approve still has to quote
 * the value the dry run printed.
 */
export interface DlqNamedIdCoverage {
    /**
     * True only when the filter named event ids AND all three lists below are
     * empty. A filter that named no ids is never complete, whatever else it
     * matched: a type or a time window still selects "whichever of those this
     * run happened to see".
     */
    complete: boolean;
    /** Named, but no message carrying that id was read at all. */
    notFound: readonly string[];
    /** Read, but some other rule skipped it. The decisions say which. */
    readButSkipped: readonly string[];
    /** Selected more than once — this queue holds more than one copy. */
    duplicated: readonly string[];
}

/** One row of the "what is sitting on this DLQ" summary. */
export interface DlqGroupCount {
    firstDeathQueue: string;
    routingKey: string;
    /** Death time truncated to the minute — exact timestamps never repeat. */
    deadLetteredAtMinute: string;
    count: number;
}

/**
 * Validate a filter before a single byte is read off the broker.
 *
 * Refuses "everything": a run with no event types, no event ids and no time
 * bound would select the whole DLQ up to `maxMessages`, which is precisely the
 * accident this tool exists to make impossible.
 */
export function validateFilter(filter: DlqReplayFilter): void {
    const hasTypes = (filter.eventTypes?.length ?? 0) > 0;
    const hasIds = (filter.eventIds?.length ?? 0) > 0;
    const hasWindow = filter.deadLetteredAfter != null || filter.deadLetteredBefore != null;
    if (!hasTypes && !hasIds && !hasWindow) {
        throw new DlqReplayRefusedError(
            'no-filter',
            'Refusing to run without a filter. Supply at least one of: event types ' +
                '(--event-type), event ids (--event-id), or a death-time window ' +
                '(--since / --until). The first-death queue and the maximum count are ' +
                'bounds, not targets — they cannot stand in for one.',
        );
    }

    if (filter.maxMessages != null) {
        if (!Number.isInteger(filter.maxMessages) || filter.maxMessages < 1) {
            throw new DlqReplayRefusedError(
                'bad-max',
                `Maximum count must be a positive whole number (got ${String(filter.maxMessages)}).`,
            );
        }
        if (filter.maxMessages > MAX_MESSAGES_CEILING) {
            throw new DlqReplayRefusedError(
                'over-ceiling',
                `Maximum count ${filter.maxMessages} is above the ${MAX_MESSAGES_CEILING} ceiling. ` +
                    'A replay this large is a backfill; write a job that can be paused and resumed.',
            );
        }
    }

    for (const bound of ['deadLetteredAfter', 'deadLetteredBefore'] as const) {
        const value = filter[bound];
        if (value != null && Number.isNaN(value.getTime())) {
            throw new DlqReplayRefusedError('bad-time', `${bound} is not a valid date.`);
        }
    }
    if (
        filter.deadLetteredAfter != null &&
        filter.deadLetteredBefore != null &&
        filter.deadLetteredAfter.getTime() > filter.deadLetteredBefore.getTime()
    ) {
        throw new DlqReplayRefusedError(
            'bad-window',
            'The death-time window is inverted: --since is later than --until.',
        );
    }
}

/**
 * Decode one raw AMQP message into a `DlqMessage`.
 *
 * Never throws: an undecodable body yields null envelope fields and is skipped
 * later by `selectForReplay`. Parsing is deliberately separate from selection
 * so the selection rules can be unit-tested without an amqp message shape.
 */
export function describeDlqMessage(
    position: number,
    content: Buffer,
    headers: Record<string, unknown> | undefined,
    deliveryRoutingKey: string,
): DlqMessage {
    const envelope = parseEnvelope(content);
    const deaths = readDeathEntries(headers);
    const mostRecent = deaths[0];
    // `x-first-death-queue` is set by the broker on the first dead-lettering and
    // never rewritten, so it survives a message that died, was replayed and died
    // again. The oldest x-death entry is the fallback for brokers or shims that
    // do not set it.
    const firstDeathQueue =
        asString(headers?.['x-first-death-queue']) ??
        asString(deaths[deaths.length - 1]?.queue) ??
        null;

    return {
        position,
        eventId: envelope?.eventId ?? null,
        eventType: envelope?.eventType ?? null,
        eventVersion: envelope?.eventVersion ?? null,
        aggregateType: envelope?.aggregateType ?? null,
        aggregateId: envelope?.aggregateId ?? null,
        firstDeathQueue,
        firstDeathReason:
            asString(headers?.['x-first-death-reason']) ??
            asString(deaths[deaths.length - 1]?.reason) ??
            null,
        routingKey: readRoutingKey(mostRecent) ?? deliveryRoutingKey,
        deadLetteredAt: readDeathTime(mostRecent?.time),
        deathCount: asNumber(mostRecent?.count) ?? 0,
    };
}

/**
 * Apply a validated filter, in the order that fails cheapest first, and stamp
 * every message with a decision so the report can explain each skip.
 *
 * `maxMessages` is applied LAST, to messages that already passed every other
 * rule — capping first would silently drop matches in favour of non-matches
 * that happened to sit closer to the head of the queue.
 *
 * WHICH matches the cap keeps does not depend on queue order. That order is not
 * stable: a scan holds every message it reads unacked and requeues the lot at
 * the end, so the approve is always reading a just-reshuffled queue. Taking "the
 * first `max` off the head" would therefore take a different subset each run,
 * hash to a different `confirmation`, and refuse the approve as a mismatch that
 * no amount of retrying could clear — while nothing about the queue had actually
 * changed. The matches are sorted by death time and then event id instead, which
 * is stable for a given SET of messages however they come off the queue, and
 * which replays the oldest first — the right order to put events back in anyway.
 *
 * `selected` is returned in that same order, and `publishSelected` republishes
 * in it.
 */
export function selectForReplay(
    messages: readonly DlqMessage[],
    filter: DlqReplayFilter,
    targetQueue: string,
): DlqSelection {
    validateFilter(filter);

    const firstDeathQueue = filter.firstDeathQueue ?? targetQueue;
    const max = filter.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const allowedTypes = filter.eventTypes?.length ? new Set(filter.eventTypes) : null;
    const allowedIds = filter.eventIds?.length ? new Set(filter.eventIds) : null;

    // Pass 1, in queue order: every rule except the cap.
    const decisions: DlqDecision[] = messages.map(message => {
        const reason = skipReasonFor(message, {
            firstDeathQueue,
            allowedTypes,
            allowedIds,
            after: filter.deadLetteredAfter,
            before: filter.deadLetteredBefore,
        });
        return { message, selected: reason === null, reason };
    });

    // Pass 2: cap the matches in the stable order described above. `decisions`
    // stays in queue order — the report walks the queue as it was read — so the
    // cap is applied by demoting the ones that fall past it in rank.
    const matched = decisions
        .filter(decision => decision.selected)
        .sort((a, b) => compareForReplay(a.message, b.message));
    for (const decision of matched.slice(max)) {
        decision.selected = false;
        decision.reason = 'over-max';
    }
    const selected = matched.slice(0, max).map(decision => decision.message);

    return {
        targetQueue,
        firstDeathQueue,
        decisions,
        selected,
        confirmation: computeConfirmation(targetQueue, firstDeathQueue, selected),
        namedIdCoverage: describeNamedIdCoverage(allowedIds, decisions, selected),
    };
}

/**
 * Digest of a selection, printed by a dry run and required back on an approve.
 *
 * Covers the destination and the SET of event ids selected, so a real change
 * between the dry run and the approve — a message drained, a new one arriving,
 * a different filter typed by mistake — produces a different value and the
 * approve is refused. Not a security token: it stops an operator acting on a
 * stale report, nothing more.
 *
 * The ids are SORTED before hashing, deliberately. Queue order is not stable
 * between runs: requeueing at the end of a scan does not preserve the DLQ's
 * order, and the dry run itself requeues everything it read, so an approve is
 * ALWAYS reading a just-requeued queue. Hashing in queue order would turn a
 * harmless reshuffle into "the dead-letter queue has changed since the dry
 * run" — a refusal that is untrue and that the operator has no way to clear.
 * What has to match is the same set of messages, not the same sequence.
 *
 * Sorting here is only half of that. It makes the digest blind to the order the
 * same messages arrive in; `selectForReplay` has to CHOOSE the same ones, which
 * is why its cap sorts too. Both halves are needed, and neither is enough on its
 * own.
 */
export function computeConfirmation(
    targetQueue: string,
    firstDeathQueue: string,
    selected: readonly DlqMessage[],
): string {
    const hash = createHash('sha256');
    hash.update(`${targetQueue}\u0000${firstDeathQueue}\u0000`);
    for (const id of selected.map(message => message.eventId ?? '').sort()) {
        hash.update(`${id}\u0000`);
    }
    return hash.digest('hex').slice(0, 12);
}

/** Group messages for the "what is on this DLQ" summary. */
export function groupDlqMessages(messages: readonly DlqMessage[]): DlqGroupCount[] {
    const groups = new Map<string, DlqGroupCount>();
    for (const message of messages) {
        const minute = message.deadLetteredAt
            ? `${message.deadLetteredAt.toISOString().slice(0, 16)}Z`
            : '(unknown)';
        const firstDeathQueue = message.firstDeathQueue ?? '(unknown)';
        const key = `${firstDeathQueue}\u0000${message.routingKey}\u0000${minute}`;
        const existing = groups.get(key);
        if (existing) {
            existing.count++;
            continue;
        }
        groups.set(key, {
            firstDeathQueue,
            routingKey: message.routingKey,
            deadLetteredAtMinute: minute,
            count: 1,
        });
    }
    return [...groups.values()].sort(
        (a, b) =>
            b.count - a.count ||
            a.firstDeathQueue.localeCompare(b.firstDeathQueue) ||
            a.routingKey.localeCompare(b.routingKey) ||
            a.deadLetteredAtMinute.localeCompare(b.deadLetteredAtMinute),
    );
}

// ─── internals ───────────────────────────────────────────────────────────

interface DeathEntry {
    queue?: unknown;
    reason?: unknown;
    time?: unknown;
    count?: unknown;
    'routing-keys'?: unknown;
}

function skipReasonFor(
    message: DlqMessage,
    rules: {
        firstDeathQueue: string;
        allowedTypes: ReadonlySet<string> | null;
        allowedIds: ReadonlySet<string> | null;
        after?: Date;
        before?: Date;
    },
): DlqSkipReason | null {
    // The shared-DLQ guard goes FIRST, ahead of even the envelope check.
    // Another service's dead letter is never ours to move, and reporting one as
    // "unparseable" would put a corruption count in front of an operator for a
    // queue that has no such problem — their own messages are all fine. Nothing
    // is selected differently either way; the skip counts just stop lying.
    if (message.firstDeathQueue !== rules.firstDeathQueue) return 'not-target-queue';

    // A body that is not a valid envelope can never be replayed: there is no
    // event type to check against the allowlist and no event id for
    // consumed_events to dedup on, and the consumer would poison-nack it
    // straight back to the DLQ. Whatever is wrong with it needs a human.
    if (message.eventId === null || message.eventType === null) return 'unparseable-envelope';

    if (rules.allowedTypes && !rules.allowedTypes.has(message.eventType)) {
        return 'event-type-not-allowed';
    }
    if (rules.allowedIds && !rules.allowedIds.has(message.eventId)) return 'event-id-not-listed';

    if (rules.after || rules.before) {
        // A window we cannot place the message in is a miss, not a pass. The
        // operator who needs this message anyway can name it with --event-id.
        if (!message.deadLetteredAt) return 'unknown-death-time';
        const at = message.deadLetteredAt.getTime();
        if (rules.after && at < rules.after.getTime()) return 'outside-time-window';
        if (rules.before && at > rules.before.getTime()) return 'outside-time-window';
    }
    return null;
}

/**
 * Order matched messages so the cap keeps the same ones however the queue was
 * shuffled: oldest death first, ties broken by event id.
 *
 * Both keys are properties of the MESSAGE, not of the run — requeueing never
 * rewrites `x-death`, so a message's death time is the same on every pass. The
 * id comparison is by code point rather than `localeCompare`, because a
 * collation that differs between two machines would put the whole point of this
 * back where it started.
 *
 * A message with no readable death time sorts last. It cannot be placed in the
 * sequence, and claiming it is the oldest thing on the queue would be a guess.
 * (With a `--since`/`--until` window such a message is already skipped as
 * `unknown-death-time`; without one it can still be selected.)
 */
function compareForReplay(a: DlqMessage, b: DlqMessage): number {
    const aTime = a.deadLetteredAt?.getTime();
    const bTime = b.deadLetteredAt?.getTime();
    if (aTime !== bTime) {
        if (aTime === undefined) return 1;
        if (bTime === undefined) return -1;
        return aTime - bTime;
    }
    const aId = a.eventId ?? '';
    const bId = b.eventId ?? '';
    return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * The `DlqNamedIdCoverage` rule, computed ONCE with its evidence attached.
 *
 * The verdict and the reasons for it have to come from the same place. The
 * verdict decides whether a truncated scan may be approved; the reasons are the
 * refusal message the operator reads when it may not. Derive them separately and
 * they can drift into contradicting each other — a refusal that names no ids, or
 * a report promising an approve that then fails — which is precisely the "true
 * but useless" failure this whole guard sequence exists to avoid.
 */
function describeNamedIdCoverage(
    allowedIds: ReadonlySet<string> | null,
    decisions: readonly DlqDecision[],
    selected: readonly DlqMessage[],
): DlqNamedIdCoverage {
    if (!allowedIds) {
        return { complete: false, notFound: [], readButSkipped: [], duplicated: [] };
    }

    const read = new Set(decisions.map(decision => decision.message.eventId));
    const selectedCounts = new Map<string, number>();
    for (const message of selected) {
        if (message.eventId === null) continue;
        selectedCounts.set(message.eventId, (selectedCounts.get(message.eventId) ?? 0) + 1);
    }

    const notFound: string[] = [];
    const readButSkipped: string[] = [];
    for (const id of allowedIds) {
        if (selectedCounts.has(id)) continue;
        (read.has(id) ? readButSkipped : notFound).push(id);
    }
    const duplicated = [...selectedCounts]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort();

    return {
        complete:
            notFound.length === 0 && readButSkipped.length === 0 && duplicated.length === 0,
        notFound: notFound.sort(),
        readButSkipped: readButSkipped.sort(),
        duplicated,
    };
}

/**
 * Tally the skip reasons in a selection, busiest first, ties broken by name.
 *
 * One tally, because there are two places that print it — the report's `Skipped`
 * block and the `nothing-selected` refusal, which prints no report — and two
 * tallies drift. The name tie-break matters for the same reason everything else
 * here sorts: equal counts left in Map insertion order come out in QUEUE order,
 * and queue order is reshuffled between runs, so the same command would print
 * its reasons in a different sequence each time.
 */
export function countSkipReasons(
    decisions: readonly DlqDecision[],
): ReadonlyArray<readonly [string, number]> {
    const counts = new Map<string, number>();
    for (const decision of decisions) {
        if (decision.selected) continue;
        const reason = decision.reason ?? 'unknown';
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function parseEnvelope(content: Buffer): EventEnvelope | null {
    try {
        const parsed = EventEnvelopeSchema.safeParse(JSON.parse(content.toString('utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/**
 * `x-death` is an array of per-(queue, reason) entries, most recent first.
 * Anything else in that header is treated as "no death information" rather
 * than throwing — a malformed header must not take the whole inspection down.
 */
function readDeathEntries(headers: Record<string, unknown> | undefined): DeathEntry[] {
    const raw = headers?.['x-death'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is DeathEntry => typeof entry === 'object' && entry !== null);
}

function readRoutingKey(entry: DeathEntry | undefined): string | null {
    const keys = entry?.['routing-keys'];
    if (!Array.isArray(keys)) return null;
    return asString(keys[0]);
}

/**
 * amqplib decodes an AMQP field-table timestamp as `{'!': 'timestamp', value: n}`
 * where `n` is SECONDS since the epoch — that is what RabbitMQ writes into
 * `x-death[].time`. Plain numbers, Dates and ISO strings are accepted too so a
 * test fake (or a future amqplib) does not have to imitate the wire encoding.
 */
export function readDeathTime(value: unknown): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'object' && value !== null && '!' in value) {
        const tagged = (value as { value?: unknown }).value;
        return typeof tagged === 'number' ? fromEpoch(tagged) : null;
    }
    if (typeof value === 'number') return fromEpoch(value);
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
}

/**
 * AMQP timestamps are seconds; a value large enough to be milliseconds is
 * treated as such, so a caller that already normalised is not thrown 50,000
 * years into the future. The 1e12 cut-off is the year 2001 in milliseconds and
 * the year 33658 in seconds — nothing real sits near it.
 */
function fromEpoch(value: number): Date | null {
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Date(value < 1e12 ? value * 1000 : value);
}

function asString(value: unknown): string | null {
    if (typeof value === 'string') return value;
    // amqplib hands back longstr fields as Buffers on some broker versions.
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return null;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
