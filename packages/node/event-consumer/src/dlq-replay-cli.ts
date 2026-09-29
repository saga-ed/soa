// Shared command-line surface for the dead-letter replay.
//
// Every service that wires this up wants the same flags, the same refusals and
// the same wording. Keeping the option spec, the string→filter conversion and
// the run itself here means a service's own CLI entry is genuinely thin — read
// config, build a connection, call `runDlqReplayCli` — and that two services
// cannot drift into subtly different definitions of `--since`, or different
// exit codes for the same outcome.
//
// The flags are deliberately plural and repeatable (`--event-type a
// --event-type b`) rather than comma-separated: an event type is a dotted
// string and a comma-split is one typo away from silently matching nothing.

import type { ILogger } from '@saga-ed/soa-logger';
import { DlqReplayRefusedError, type DlqReplayFilter } from './dlq-replay.js';
import {
    formatInspectionReport,
    formatReplayReport,
    inspectDeadLetterQueue,
    replayDeadLetters,
    type DlqChannelSource,
} from './dlq-replay-runner.js';

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

/** The wiring service's own defaults, applied when the operator names none. */
export interface DlqReplayCliDefaults {
    eventTypes?: readonly string[];
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
    defaults: DlqReplayCliDefaults = {},
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

    // The repeatable flags are checked element by element. `--event-type ""`
    // parses to [''], which matches no message: the run would then select
    // nothing, report "(nothing matched the filter)" and exit 0 — a typo in a
    // runbook step reading as a clean run, which is the worst outcome here.
    const eventIds = requireEach('--event-id', values['event-id']);
    const namedTypes = requireEach('--event-type', values['event-type']);
    const eventTypes = namedTypes?.length ? namedTypes : (defaults.eventTypes ?? undefined);

    // Every flag below is checked for PRESENCE, not truthiness. `--since ""`
    // passes an empty string, and treating that as "not given" would silently
    // widen the selection past what the operator believes they typed — the
    // exact false signal this tool cannot afford. An empty value is refused.
    const filter: DlqReplayFilter = {
        ...maybe('firstDeathQueue', require_('--first-death-queue', values['first-death-queue'])),
        ...(eventTypes?.length ? { eventTypes } : {}),
        ...(eventIds?.length ? { eventIds } : {}),
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

/**
 * A broker connection the CLI owns for the length of one run.
 *
 * `@saga-ed/soa-rabbitmq`'s `ConnectionManager` satisfies it. Note that
 * `DlqChannelSource` — what `inspectDeadLetterQueue`/`replayDeadLetters` take —
 * deliberately does NOT require `close()`: those functions are given a
 * connection the calling service owns and keeps, and closing it under a
 * long-running service would be wrong. Closing belongs to whoever owns it,
 * which for a one-shot CLI is this module.
 */
export interface DlqReplayConnection extends DlqChannelSource {
    /**
     * Should not throw — a tidy-up failure must not replace the run's outcome.
     * `ConnectionManager.close()` guarantees this; `runDlqReplayCli` still
     * guards, because any implementation can satisfy a structural interface.
     */
    close(): Promise<void>;
}

export interface RunDlqReplayCliOptions {
    /** Parsed `DLQ_REPLAY_CLI_OPTIONS` values (plus any of the caller's own). */
    values: DlqReplayCliValues;
    /**
     * The connection for this run. `runDlqReplayCli` TAKES OWNERSHIP: it closes
     * the connection before returning, on every path. Do not hand it one the
     * process still needs.
     */
    connection: DlqReplayConnection;
    /** The dead-letter queue to read, e.g. `iam.events.dlq.queue`. */
    dlqQueue: string;
    /** The queue to replay into — the service's OWN consumer queue. */
    targetQueue: string;
    /** The service's allowlist of types safe to re-run. See `filterFromCliValues`. */
    defaults?: DlqReplayCliDefaults;
    logger: ILogger;
    /** Where the report goes. Defaults to stdout. */
    write?: (report: string) => void;
}

/**
 * Run one inspect-or-replay from parsed flags and return the process exit code.
 *
 * Exit codes, so a runbook step that half-succeeded cannot look like a clean
 * run to whatever called it:
 *
 * - `0` — the run did what was asked and there is nothing outstanding.
 * - `1` — a refusal, or a replay that stopped on a failed publish. The report
 *   (or the refusal message) says which.
 * - `2` — a dry run that selected messages: work found, nothing published yet.
 *   Distinguishable from "nothing to do" without parsing the report.
 *
 * Anything else — a broker error, a bug — propagates with its stack, because
 * a surprise is worth seeing in full. The connection is closed either way.
 *
 * Closing the connection is the point of returning a code rather than calling
 * `process.exit`: a live AMQP socket holds Node's event loop open, so a CLI
 * that just stops has to be killed, which throws away whatever else was
 * pending. Closed, the process ends on its own with the code the caller set.
 *
 * The README's "Recovering dead letters" section has the wiring.
 */
export async function runDlqReplayCli(opts: RunDlqReplayCliOptions): Promise<number> {
    const write = opts.write ?? ((report: string) => console.log(report));
    try {
        const args = filterFromCliValues(opts.values, opts.defaults);

        if (args.inspect) {
            const inspection = await inspectDeadLetterQueue({
                connectionManager: opts.connection,
                dlqQueue: opts.dlqQueue,
                scanLimit: args.scanLimit,
                logger: opts.logger,
            });
            write(formatInspectionReport(inspection));
            return 0;
        }

        const result = await replayDeadLetters({
            connectionManager: opts.connection,
            dlqQueue: opts.dlqQueue,
            targetQueue: opts.targetQueue,
            scanLimit: args.scanLimit,
            filter: args.filter,
            approve: args.approve,
            confirm: args.confirm,
            logger: opts.logger,
        });
        write(formatReplayReport(result));

        if (result.failure) return 1;
        if (!result.approved && result.selection.selected.length > 0) return 2;
        return 0;
    } catch (error) {
        // A refusal is this tool working: the operator is told what it would not
        // do and why. It is not a stack trace, but it is not a success either.
        if (error instanceof DlqReplayRefusedError) {
            write(`Refused (${error.reason}): ${error.message}`);
            return 1;
        }
        throw error;
    } finally {
        // The connection is closed whatever happened above — including on the
        // refusal path, where it may never have been opened at all (closing an
        // unconnected manager is a no-op). The guard is for implementations
        // that are NOT `ConnectionManager`, which guarantees a close cannot
        // throw: a tidy-up failure must not replace the outcome the operator
        // is waiting for.
        try {
            await opts.connection.close();
        } catch (error) {
            opts.logger.warn('[DlqReplay] could not close the broker connection', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
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
/** The same rule for a repeatable flag: every value it was given must carry one. */
function requireEach(flag: string, values: string[] | undefined): string[] | undefined {
    values?.forEach(value => require_(flag, value));
    return values;
}

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
