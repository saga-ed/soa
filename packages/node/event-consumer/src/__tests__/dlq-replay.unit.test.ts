import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MAX_MESSAGES,
    DlqReplayRefusedError,
    MAX_MESSAGES_CEILING,
    computeConfirmation,
    describeDlqMessage,
    groupDlqMessages,
    readDeathTime,
    selectForReplay,
    validateFilter,
    type DlqMessage,
} from '../dlq-replay.js';

/**
 * The refusal rules are the point of this tool — Seth's whole concern was
 * "don't accidentally replay all history". These cover the five ways a run is
 * refused or narrowed: no filter at all, a count above the ceiling, a message
 * that died on somebody else's queue, an event type the service did not
 * allowlist, and a confirmation that no longer describes the queue.
 */

const TARGET_QUEUE = 'coach-api.instance-creation';

let nextId = 0;
function message(overrides: Partial<DlqMessage> = {}): DlqMessage {
    nextId++;
    return {
        position: nextId,
        eventId: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
        eventType: 'iam.persona_assignment.added',
        eventVersion: 1,
        aggregateType: 'persona_assignment',
        aggregateId: `row-${nextId}`,
        firstDeathQueue: TARGET_QUEUE,
        firstDeathReason: 'rejected',
        routingKey: 'iam.persona_assignment.added',
        deadLetteredAt: new Date('2026-09-16T14:30:00Z'),
        deathCount: 1,
        ...overrides,
    };
}

function envelopeBuffer(overrides: Record<string, unknown> = {}): Buffer {
    return Buffer.from(
        JSON.stringify({
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'iam.persona_assignment.added',
            eventVersion: 1,
            aggregateType: 'persona_assignment',
            aggregateId: 'row-1',
            occurredAt: '2026-09-16T14:29:00Z',
            payload: { id: 'row-1' },
            ...overrides,
        }),
    );
}

describe('validateFilter', () => {
    it('refuses a run with no targeting at all', () => {
        expect(() => validateFilter({})).toThrow(DlqReplayRefusedError);
        expect(() => validateFilter({})).toThrow(/Refusing to run without a filter/);
    });

    it('refuses a first-death queue or a max as the only targeting', () => {
        // Neither is a target: firstDeathQueue always has a value (it defaults to
        // the target queue) and a cap only bounds the damage.
        expect(() => validateFilter({ firstDeathQueue: TARGET_QUEUE })).toThrow(
            DlqReplayRefusedError,
        );
        expect(() => validateFilter({ maxMessages: 5 })).toThrow(DlqReplayRefusedError);
    });

    it('accepts any one of event types, event ids or a time bound', () => {
        expect(() => validateFilter({ eventTypes: ['a'] })).not.toThrow();
        expect(() => validateFilter({ eventIds: ['b'] })).not.toThrow();
        expect(() => validateFilter({ deadLetteredAfter: new Date() })).not.toThrow();
        expect(() => validateFilter({ deadLetteredBefore: new Date() })).not.toThrow();
    });

    it('refuses a maximum above the ceiling', () => {
        expect(() =>
            validateFilter({ eventTypes: ['a'], maxMessages: MAX_MESSAGES_CEILING + 1 }),
        ).toThrow(/above the 500 ceiling/);
    });

    it('refuses a maximum that is not a positive whole number', () => {
        expect(() => validateFilter({ eventTypes: ['a'], maxMessages: 0 })).toThrow(
            /positive whole number/,
        );
        expect(() => validateFilter({ eventTypes: ['a'], maxMessages: 2.5 })).toThrow(
            /positive whole number/,
        );
    });

    it('refuses an inverted time window', () => {
        expect(() =>
            validateFilter({
                deadLetteredAfter: new Date('2026-09-17T00:00:00Z'),
                deadLetteredBefore: new Date('2026-09-16T00:00:00Z'),
            }),
        ).toThrow(/inverted/);
    });
});

describe('selectForReplay', () => {
    it('skips a message whose first death was another service’s queue', () => {
        const mine = message();
        const theirs = message({ firstDeathQueue: 'sessions-api.iam-projection' });
        const selection = selectForReplay(
            [mine, theirs],
            { eventTypes: ['iam.persona_assignment.added'] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([mine]);
        expect(selection.decisions[1]).toMatchObject({
            selected: false,
            reason: 'not-target-queue',
        });
    });

    it('skips an event type that is not on the allowlist', () => {
        const allowed = message();
        const other = message({ eventType: 'iam.persona_definition.upserted' });
        const selection = selectForReplay(
            [allowed, other],
            { eventTypes: ['iam.persona_assignment.added'] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([allowed]);
        expect(selection.decisions[1]?.reason).toBe('event-type-not-allowed');
    });

    it('skips an event id that was not listed', () => {
        const wanted = message();
        const other = message();
        const selection = selectForReplay(
            [wanted, other],
            { eventIds: [wanted.eventId as string] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([wanted]);
        expect(selection.decisions[1]?.reason).toBe('event-id-not-listed');
    });

    it('never selects an unparseable envelope, however wide the filter', () => {
        const broken = message({ eventId: null, eventType: null });
        const selection = selectForReplay(
            [broken],
            { eventTypes: ['iam.persona_assignment.added'], eventIds: ['anything'] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([]);
        expect(selection.decisions[0]?.reason).toBe('unparseable-envelope');
    });

    it('blames another service’s queue before calling its message unparseable', () => {
        // On a shared DLQ, someone else's non-envelope message is not this
        // operator's corruption to worry about. Reporting it as unparseable
        // would put a scary count in front of them for a queue that is fine.
        const theirsAndBroken = message({
            eventId: null,
            eventType: null,
            firstDeathQueue: 'sessions-api.iam-projection',
        });
        const selection = selectForReplay(
            [theirsAndBroken],
            { eventTypes: ['iam.persona_assignment.added'] },
            TARGET_QUEUE,
        );
        expect(selection.decisions[0]?.reason).toBe('not-target-queue');
        expect(selection.selected).toEqual([]);
    });

    it('applies the death-time window, and treats an unknown death time as a miss', () => {
        const inside = message({ deadLetteredAt: new Date('2026-09-16T14:30:00Z') });
        const before = message({ deadLetteredAt: new Date('2026-09-16T10:00:00Z') });
        const after = message({ deadLetteredAt: new Date('2026-09-16T20:00:00Z') });
        const unknown = message({ deadLetteredAt: null });
        const selection = selectForReplay(
            [inside, before, after, unknown],
            {
                deadLetteredAfter: new Date('2026-09-16T14:00:00Z'),
                deadLetteredBefore: new Date('2026-09-16T16:00:00Z'),
            },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([inside]);
        expect(selection.decisions.map(d => d.reason)).toEqual([
            null,
            'outside-time-window',
            'outside-time-window',
            'unknown-death-time',
        ]);
    });

    it('caps at the maximum, and caps AFTER the other rules so matches are not crowded out', () => {
        // The two non-matching messages sit at the head of the queue. A cap
        // applied before the type check would consume the budget on them and
        // report "nothing to replay".
        const wrongType = message({ eventType: 'iam.persona_definition.upserted' });
        const alsoWrong = message({ eventType: 'iam.persona_definition.upserted' });
        const first = message();
        const second = message();
        const selection = selectForReplay(
            [wrongType, alsoWrong, first, second],
            { eventTypes: ['iam.persona_assignment.added'], maxMessages: 1 },
            TARGET_QUEUE,
        );
        expect(selection.selected).toEqual([first]);
        expect(selection.decisions[3]?.reason).toBe('over-max');
    });

    it('defaults the maximum to a conservative count', () => {
        const many = Array.from({ length: DEFAULT_MAX_MESSAGES + 5 }, () => message());
        const selection = selectForReplay(
            many,
            { eventTypes: ['iam.persona_assignment.added'] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toHaveLength(DEFAULT_MAX_MESSAGES);
    });

    it('defaults the first-death queue to the target queue', () => {
        const selection = selectForReplay([], { eventTypes: ['a'] }, TARGET_QUEUE);
        expect(selection.firstDeathQueue).toBe(TARGET_QUEUE);
    });

    it('refuses an untargeted filter before looking at any message', () => {
        expect(() => selectForReplay([message()], {}, TARGET_QUEUE)).toThrow(DlqReplayRefusedError);
    });
});

/**
 * WHICH matches the cap keeps must not depend on where they sat in the queue.
 * A scan holds everything it reads unacked and requeues the lot, so the approve
 * always reads a reshuffled queue: "the first `max` off the head" would take a
 * different subset each run, hash to a different confirmation, and refuse the
 * approve as a mismatch that retrying could never clear — with nothing about the
 * queue having actually changed.
 */
const TYPES = { eventTypes: ['iam.persona_assignment.added'] };

describe('selectForReplay ordering', () => {

    it('keeps the same messages under --max however the queue was shuffled', () => {
        const oldest = message({ deadLetteredAt: new Date('2026-09-16T14:00:00Z') });
        const middle = message({ deadLetteredAt: new Date('2026-09-16T15:00:00Z') });
        const newest = message({ deadLetteredAt: new Date('2026-09-16T16:00:00Z') });
        const filter = { ...TYPES, maxMessages: 2 };

        const inOrder = selectForReplay([oldest, middle, newest], filter, TARGET_QUEUE);
        const shuffled = selectForReplay([newest, oldest, middle], filter, TARGET_QUEUE);

        expect(inOrder.selected).toEqual([oldest, middle]);
        expect(shuffled.selected).toEqual([oldest, middle]);
        expect(shuffled.confirmation).toBe(inOrder.confirmation);
        // Decisions stay in queue order — the report walks the queue as read —
        // and over-max lands on the same message either way.
        expect(shuffled.decisions[0]).toMatchObject({ message: newest, reason: 'over-max' });
        expect(inOrder.decisions[2]).toMatchObject({ message: newest, reason: 'over-max' });
    });

    it('replays oldest first', () => {
        const oldest = message({ deadLetteredAt: new Date('2026-09-16T14:00:00Z') });
        const newest = message({ deadLetteredAt: new Date('2026-09-16T16:00:00Z') });
        expect(selectForReplay([newest, oldest], TYPES, TARGET_QUEUE).selected).toEqual([
            oldest,
            newest,
        ]);
    });

    it('breaks a death-time tie on event id, by code point', () => {
        // Everything dead-lettered in the same second by one bad deploy is the
        // normal case, not the exotic one — the tie-break carries the weight.
        const at = new Date('2026-09-16T14:30:00Z');
        const id = (lead: string) => `${lead.repeat(8)}-0000-4000-8000-000000000000`;
        const first = message({ eventId: id('a'), deadLetteredAt: at });
        const second = message({ eventId: id('b'), deadLetteredAt: at });
        const filter = { ...TYPES, maxMessages: 1 };
        expect(selectForReplay([second, first], filter, TARGET_QUEUE).selected).toEqual([first]);
        expect(selectForReplay([first, second], filter, TARGET_QUEUE).selected).toEqual([first]);
    });

    it('puts a message with no death time last rather than calling it the oldest', () => {
        const known = message({ deadLetteredAt: new Date('2026-09-16T18:00:00Z') });
        const unknown = message({ deadLetteredAt: null });
        const filter = { ...TYPES, maxMessages: 1 };
        expect(selectForReplay([unknown, known], filter, TARGET_QUEUE).selected).toEqual([known]);
    });
});

/**
 * `namedIdCoverage` is what lets a targeted replay proceed on a queue too deep to
 * scan whole — so the conditions on it have to be exactly right. Each incomplete
 * case below is one where two runs could select different things and mismatch,
 * and each carries the ids that say why, because those become the refusal an
 * operator reads.
 */
describe('selectForReplay namedIdCoverage', () => {

    it('is true when every named event id was selected, exactly once', () => {
        const a = message();
        const b = message();
        const selection = selectForReplay(
            [a, b, message()],
            { eventIds: [a.eventId as string, b.eventId as string] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toHaveLength(2);
        expect(selection.namedIdCoverage.complete).toBe(true);
    });

    it('is false without --event-id, however narrow the other filters are', () => {
        // A type or a time window still selects "whatever of those is in this
        // part of the queue", which is a different set from a different window.
        const selection = selectForReplay([message()], TYPES, TARGET_QUEUE);
        expect(selection.selected).toHaveLength(1);
        expect(selection.namedIdCoverage.complete).toBe(false);
    });

    it('is false when a named id was not found', () => {
        const a = message();
        const selection = selectForReplay(
            [a],
            { eventIds: [a.eventId as string, 'ffffffff-0000-4000-8000-000000000000'] },
            TARGET_QUEUE,
        );
        expect(selection.namedIdCoverage).toMatchObject({
            complete: false,
            notFound: ['ffffffff-0000-4000-8000-000000000000'],
            readButSkipped: [],
            duplicated: [],
        });
    });

    it('is false when a named id was found twice', () => {
        // Which this tool creates itself: a replayed copy that fails again
        // dead-letters next to the original under the same event id. One window
        // sees one copy, another sees two, and the digests differ.
        const a = message();
        const duplicate = message({ eventId: a.eventId });
        const selection = selectForReplay(
            [a, duplicate],
            { eventIds: [a.eventId as string] },
            TARGET_QUEUE,
        );
        expect(selection.selected).toHaveLength(2);
        expect(selection.namedIdCoverage).toMatchObject({
            complete: false,
            notFound: [],
            readButSkipped: [],
            duplicated: [a.eventId],
        });
    });

    it('is complete when --max cuts a duplicate copy back to one', () => {
        // Deliberate, not an oversight. With only one copy selected, the set of
        // ids hashed is exactly the named list whichever copy was taken — so the
        // confirmation IS reproducible, which is all `complete` promises. The
        // rule is about the SELECTION, not about what else the queue holds.
        const a = message();
        const duplicate = message({ eventId: a.eventId });
        const selection = selectForReplay(
            [a, duplicate],
            { eventIds: [a.eventId as string], maxMessages: 1 },
            TARGET_QUEUE,
        );
        expect(selection.selected).toHaveLength(1);
        expect(selection.namedIdCoverage.complete).toBe(true);
    });

    it('is false when a named id was found but skipped by another rule', () => {
        const mine = message();
        const theirs = message({ firstDeathQueue: 'sessions-api.iam-projection' });
        const selection = selectForReplay(
            [mine, theirs],
            { eventIds: [mine.eventId as string, theirs.eventId as string] },
            TARGET_QUEUE,
        );
        // Read, not missing — the distinction the refusal message turns on.
        expect(selection.namedIdCoverage).toMatchObject({
            complete: false,
            notFound: [],
            readButSkipped: [theirs.eventId],
            duplicated: [],
        });
    });

    it('is false when the cap cut one of the named ids', () => {
        const a = message();
        const b = message();
        const selection = selectForReplay(
            [a, b],
            { eventIds: [a.eventId as string, b.eventId as string], maxMessages: 1 },
            TARGET_QUEUE,
        );
        expect(selection.namedIdCoverage.complete).toBe(false);
    });
});

describe('computeConfirmation', () => {
    it('is stable for the same selection and changes when the selection does', () => {
        const a = message();
        const b = message();
        const base = computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [a, b]);

        expect(computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [a, b])).toBe(base);
        // One message drained since the dry run.
        expect(computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [a])).not.toBe(base);
        // A new one arrived.
        expect(computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [a, b, message()])).not.toBe(base);
        // Different destination.
        expect(computeConfirmation('other.queue', TARGET_QUEUE, [a, b])).not.toBe(base);
        // Different first-death queue.
        expect(computeConfirmation(TARGET_QUEUE, 'other.queue', [a, b])).not.toBe(base);
    });

    it('does NOT change when the same messages come back in a different order', () => {
        // The dry run requeues everything it read, so the approve is always
        // reading a just-requeued queue and the order can differ. If that
        // changed the digest, the approve would be refused with "the queue has
        // changed" when nothing had, and retrying could never clear it.
        const a = message();
        const b = message();
        const c = message();
        const inOrder = computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [a, b, c]);
        expect(computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [c, a, b])).toBe(inOrder);
        expect(computeConfirmation(TARGET_QUEUE, TARGET_QUEUE, [b, c, a])).toBe(inOrder);
    });
});

describe('describeDlqMessage', () => {
    it('reads the envelope, the first-death headers and the most recent death time', () => {
        const described = describeDlqMessage(
            1,
            envelopeBuffer(),
            {
                'x-first-death-queue': TARGET_QUEUE,
                'x-first-death-reason': 'rejected',
                'x-death': [
                    {
                        queue: TARGET_QUEUE,
                        reason: 'rejected',
                        count: 2,
                        time: { '!': 'timestamp', value: 1789000000 },
                        'routing-keys': ['iam.persona_assignment.added'],
                    },
                ],
            },
            'ignored.delivery.key',
        );

        expect(described).toMatchObject({
            position: 1,
            eventId: '11111111-1111-4111-8111-111111111111',
            eventType: 'iam.persona_assignment.added',
            eventVersion: 1,
            aggregateId: 'row-1',
            firstDeathQueue: TARGET_QUEUE,
            firstDeathReason: 'rejected',
            routingKey: 'iam.persona_assignment.added',
            deathCount: 2,
        });
        expect(described.deadLetteredAt?.toISOString()).toBe(
            new Date(1789000000 * 1000).toISOString(),
        );
    });

    it('falls back to the oldest x-death entry when the first-death headers are missing', () => {
        const described = describeDlqMessage(
            1,
            envelopeBuffer(),
            {
                'x-death': [
                    { queue: 'second.queue', reason: 'expired', count: 1, time: 1789000100 },
                    { queue: 'original.queue', reason: 'rejected', count: 1, time: 1789000000 },
                ],
            },
            'delivery.key',
        );
        expect(described.firstDeathQueue).toBe('original.queue');
        expect(described.firstDeathReason).toBe('rejected');
        // Death time is the MOST RECENT death — when it landed on this DLQ.
        expect(described.deadLetteredAt?.toISOString()).toBe(
            new Date(1789000100 * 1000).toISOString(),
        );
    });

    it('survives a body that is not an envelope, and a malformed x-death header', () => {
        const described = describeDlqMessage(
            7,
            Buffer.from('not json at all'),
            { 'x-death': 'not an array' },
            'delivery.key',
        );
        expect(described).toMatchObject({
            position: 7,
            eventId: null,
            eventType: null,
            firstDeathQueue: null,
            routingKey: 'delivery.key',
            deadLetteredAt: null,
            deathCount: 0,
        });
    });

    it('rejects a body that is valid JSON but not a valid envelope', () => {
        const described = describeDlqMessage(
            1,
            Buffer.from(JSON.stringify({ eventType: 'x', eventId: 'not-a-uuid' })),
            undefined,
            'delivery.key',
        );
        expect(described.eventId).toBeNull();
    });
});

describe('readDeathTime', () => {
    it('reads the shapes amqplib and a test fake can produce', () => {
        expect(readDeathTime({ '!': 'timestamp', value: 1789000000 })?.getTime()).toBe(
            1789000000_000,
        );
        // Bare seconds.
        expect(readDeathTime(1789000000)?.getTime()).toBe(1789000000_000);
        // Already milliseconds.
        expect(readDeathTime(1789000000_000)?.getTime()).toBe(1789000000_000);
        expect(readDeathTime(new Date('2026-09-16T14:00:00Z'))?.toISOString()).toBe(
            '2026-09-16T14:00:00.000Z',
        );
        expect(readDeathTime('2026-09-16T14:00:00Z')?.toISOString()).toBe(
            '2026-09-16T14:00:00.000Z',
        );
        expect(readDeathTime(undefined)).toBeNull();
        expect(readDeathTime('nonsense')).toBeNull();
        expect(readDeathTime(0)).toBeNull();
    });
});

describe('groupDlqMessages', () => {
    it('counts by first-death queue, routing key and death minute, busiest first', () => {
        const groups = groupDlqMessages([
            message({ deadLetteredAt: new Date('2026-09-16T14:30:10Z') }),
            message({ deadLetteredAt: new Date('2026-09-16T14:30:55Z') }),
            message({
                deadLetteredAt: new Date('2026-09-16T15:00:00Z'),
                routingKey: 'iam.persona_assignment.removed',
            }),
            message({ deadLetteredAt: null }),
        ]);

        expect(groups[0]).toEqual({
            firstDeathQueue: TARGET_QUEUE,
            routingKey: 'iam.persona_assignment.added',
            deadLetteredAtMinute: '2026-09-16T14:30Z',
            count: 2,
        });
        expect(groups).toHaveLength(3);
        expect(groups.map(g => g.deadLetteredAtMinute)).toContain('(unknown)');
    });
});
