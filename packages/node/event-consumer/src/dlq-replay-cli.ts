// Shared command-line surface for the dead-letter replay.
//
// Every service that wires this up wants the same flags, the same refusals and
// the same wording. Keeping the option spec and the string→filter conversion
// here means a service's own CLI entry is genuinely thin — read config, call
// this, call `replayDeadLetters` — and that two services cannot drift into
// subtly different definitions of `--since`.
//
// The flags are deliberately plural and repeatable (`--event-type a
// --event-type b`) rather than comma-separated: an event type is a dotted
// string and a comma-split is one typo away from silently matching nothing.

import { DlqReplayRefusedError, type DlqReplayFilter } from './dlq-replay.js';

/**
 * Option spec for `node:util`'s `parseArgs`. Spread into a caller's own options
 * so a service can add its own flags alongside.
 */
export const DLQ_REPLAY_CLI_OPTIONS = {
    /** Read and report only; never selects or publishes. */
    inspect: { type: 'boolean', default: false },
    'event-type': { type: 'string', multiple: true },
    'event-id': { type: 'string', multiple: true },
    /** Death-time lower bound, any format `new Date()` accepts; ISO-8601 preferred. */
    since: { type: 'string' },
    /** Death-time upper bound. */
    until: { type: 'string' },
    /** Override the first-death queue to match on. Defaults to the target queue. */
    'first-death-queue': { type: 'string' },
    /** Maximum number of messages to replay. */
    max: { type: 'string' },
    /** How many messages to read off the dead-letter queue. */
    'scan-limit': { type: 'string' },
    /** Actually publish. Without it the run is a dry run. */
    approve: { type: 'boolean', default: false },
    /** The confirmation value printed by the dry run. Required with `--approve`. */
    confirm: { type: 'string' },
} as const;

/** The parsed shape of `DLQ_REPLAY_CLI_OPTIONS`. */
export interface DlqReplayCliValues {
    inspect?: boolean;
    'event-type'?: string[];
    'event-id'?: string[];
    since?: string;
    until?: string;
    'first-death-queue'?: string;
    max?: string;
    'scan-limit'?: string;
    approve?: boolean;
    confirm?: string;
}

export interface DlqReplayCliArgs {
    inspect: boolean;
    filter: DlqReplayFilter;
    scanLimit: number | undefined;
    approve: boolean;
    confirm: string | undefined;
}

/**
 * Turn parsed flags into a filter, refusing anything malformed before the
 * broker is opened.
 *
 * `defaultEventTypes` is the wiring service's allowlist — the types it has
 * decided are safe to re-run (see the "what is NOT safe to replay" note in
 * `dlq-replay.ts`). It applies only when the operator names none; naming
 * `--event-type` explicitly replaces it rather than adding to it, so an
 * operator can narrow to one type but has to say so.
 *
 * Note what this does NOT do: it never widens. If the service's default list is
 * empty and the operator names no types, the run still has to be targeted some
 * other way (ids or a window) or `validateFilter` refuses it.
 */
export function filterFromCliValues(
    values: DlqReplayCliValues,
    defaults: { eventTypes?: readonly string[] } = {},
): DlqReplayCliArgs {
    // `--inspect` reads and reports; it can never publish. Quietly ignoring an
    // `--approve` alongside it would leave an operator believing they had just
    // replayed something, which is the worst possible thing to be wrong about
    // here. Make them pick.
    if (values.inspect && (values.approve || values.confirm)) {
        throw new DlqReplayRefusedError(
            'inspect-with-approve',
            '--inspect only reads the queue and cannot publish anything, so --approve / ' +
                '--confirm would do nothing. Drop --inspect to replay, or drop --approve ' +
                'and --confirm to look.',
        );
    }

    const eventTypes = values['event-type']?.length
        ? values['event-type']
        : (defaults.eventTypes ?? undefined);

    // Every flag below is checked for PRESENCE, not truthiness. `--since ""`
    // passes an empty string, and treating that as "not given" would silently
    // widen the selection past what the operator believes they typed — the
    // exact false signal this tool cannot afford. An empty value is refused.
    const filter: DlqReplayFilter = {
        ...maybe('firstDeathQueue', require_('--first-death-queue', values['first-death-queue'])),
        ...(eventTypes?.length ? { eventTypes } : {}),
        ...(values['event-id']?.length ? { eventIds: values['event-id'] } : {}),
        ...maybe(
            'deadLetteredAfter',
            mapDefined(require_('--since', values.since), raw => parseDate('--since', raw)),
        ),
        ...maybe(
            'deadLetteredBefore',
            mapDefined(require_('--until', values.until), raw => parseDate('--until', raw)),
        ),
        ...maybe(
            'maxMessages',
            mapDefined(require_('--max', values.max), raw => parseCount('--max', raw)),
        ),
    };

    return {
        inspect: values.inspect ?? false,
        filter,
        scanLimit: mapDefined(require_('--scan-limit', values['scan-limit']), raw =>
            parseCount('--scan-limit', raw),
        ),
        approve: values.approve ?? false,
        confirm: require_('--confirm', values.confirm),
    };
}

/** `{ key: value }` when the value is defined, `{}` when it is not. */
function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
    return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function mapDefined<T, R>(value: T | undefined, fn: (value: T) => R): R | undefined {
    return value === undefined ? undefined : fn(value);
}

/**
 * A flag that was given must carry a value. `parseArgs` hands back `''` for
 * `--since ""`, which is a typo, not an instruction to ignore the flag.
 */
function require_(flag: string, value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (value.trim() === '') {
        throw new DlqReplayRefusedError(
            'empty-flag',
            `${flag} was given with an empty value. Drop the flag, or give it one.`,
        );
    }
    return value;
}

function parseDate(flag: string, raw: string): Date {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        throw new DlqReplayRefusedError(
            'bad-time',
            `${flag} is not a date this can read: "${raw}". Use an ISO-8601 instant, ` +
                'e.g. 2026-09-16T14:00:00Z.',
        );
    }
    return parsed;
}

function parseCount(flag: string, raw: string): number {
    // Number() would take "1e3", " 12 " and "0x10"; a whole-number regex is the
    // only reading of a count flag that cannot surprise the person typing it.
    if (!/^\d+$/.test(raw)) {
        throw new DlqReplayRefusedError(
            'bad-count',
            `${flag} must be a whole number (got "${raw}").`,
        );
    }
    return Number(raw);
}
