import { Pool, type PoolConfig } from 'pg';
import type { ILogger } from '@saga-ed/soa-logger';
import {
    OUTBOX_UNPUBLISHED_INDEX_NAME,
    OUTBOX_UNPUBLISHED_INDEX_SQL,
    OUTBOX_UNPUBLISHED_INDEX_REPAIR_SQL,
} from './schema.js';

export interface CreateOutboxPoolOpts {
    /**
     * Max connections in the dedicated relay pool. Defaults to 4 — enough
     * headroom for the polling tick, a concurrent retry of a failed batch,
     * and a liveness probe without queuing. Keep it small so it cannot
     * starve request-path Prisma traffic, especially in preview environments
     * where many PRs share a single Postgres instance; outbox traffic is
     * bursty and short-lived, so 4 saturates rare bursts without holding
     * connections idle. program-hub's programs-api uses this value in
     * production; rostering's iam-api leaves it at the default. Bump only
     * if relay-tick latency shows actual queue depth on the pool.
     */
    max?: number;
    /**
     * Override pg pool options (e.g., `idleTimeoutMillis`). Merged on top of
     * the defaults derived from `databaseUrl`. `poolOverrides` wins over both
     * the default `max` and the schema-derived `options` — escape hatch for
     * advanced cases.
     */
    poolOverrides?: Partial<PoolConfig>;
}

// Postgres unquoted-identifier grammar (lowercased on entry by the server, but
// we accept the literal forms to allow both `pr_142` and `Pr_142` styles).
// Anything outside this set could inject a libpq startup parameter via the
// `-c search_path=<schema>` form (e.g. ` -c statement_timeout=0`), so we
// reject it loudly rather than silently exec'ing the unintended option.
const SCHEMA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the dedicated `pg.Pool` used by `OutboxRelay`.
 *
 * The Postgres URL produced by Prisma carries the schema as a query parameter
 * (`?schema=pr_142`). node-postgres ignores that parameter, so unqualified
 * table references like `FROM outbox_event` fall through to the default
 * `search_path` and miss per-PR schema tables. This helper translates the
 * Prisma form into libpq's `options=-c search_path=<schema>` so both sides
 * resolve to the same schema — the load-bearing piece of preview-environment
 * isolation (see d-preview-deploy-isolation.md).
 *
 * The helper is intentionally production-safe: when neither `?schema=` nor
 * `EVENT_PREVIEW_TAG` are set, it's equivalent to
 * `new Pool({ connectionString, max: 4 })`. The startup coherence assert
 * (below) ensures preview state can't leak in by accident — that's what
 * makes a single helper safe across both environments.
 *
 * Supported `databaseUrl` shape:
 *   - URL form only (`postgresql://…`). The libpq KV form
 *     (`host=… dbname=…`) is not supported — pass a URL.
 *   - Optional `?schema=<name>` query parameter, where `<name>` matches
 *     `[A-Za-z_][A-Za-z0-9_]*` (Postgres unquoted-identifier rules).
 *     Hyphenated preview identifiers like `pr-42` belong to AWS resource
 *     names; convert to `pr_42` before constructing the URL.
 *   - Other URL params (`?options=`, `?sslmode=`, etc.) ride along via
 *     `connectionString` and are NOT interpreted by this helper. Use
 *     `opts.poolOverrides` to set additional pg.Pool config explicitly.
 *
 * Throws on:
 *   - non-URL `databaseUrl`
 *   - `?schema=` value outside the unquoted-identifier regex
 *   - `?schema=` set but `EVENT_PREVIEW_TAG` unset (would produce
 *     half-isolated state: per-PR DB, canonical RabbitMQ exchange — leaks
 *     events across PRs)
 *   - `EVENT_PREVIEW_TAG` set but `?schema=` absent (the inverse half-
 *     isolated state: per-PR RabbitMQ tag, default DB schema — leaks outbox
 *     rows across PRs)
 *
 * @example
 *   const pool = createOutboxPool(process.env.DATABASE_URL!);
 *   const relay = new OutboxRelay({ pool, ...rest });
 */
export function createOutboxPool(
    databaseUrl: string,
    opts: CreateOutboxPoolOpts = {},
): Pool {
    let url: URL;
    try {
        url = new URL(databaseUrl);
    } catch {
        throw new Error(
            `createOutboxPool: \`databaseUrl\` must be a URL-form connection string (e.g. postgresql://…). Received: ${truncate(databaseUrl)}`,
        );
    }

    const schemaParam = url.searchParams.get('schema');
    // Treat empty `?schema=` (present-but-empty) the same as absent. libpq with
    // `-c search_path=` (empty) would error; absent is what callers mean.
    const schema = schemaParam === null || schemaParam === '' ? null : schemaParam;
    if (schema !== null && !SCHEMA_IDENTIFIER.test(schema)) {
        throw new Error(
            `createOutboxPool: \`?schema=\` must match ${SCHEMA_IDENTIFIER} to be safely interpolated into libpq options. Received: ${truncate(schema)}`,
        );
    }

    // Coherence assert: the two-axis preview-isolation model
    // (DB schema-per-PR + RabbitMQ tag-per-PR) must be applied as a pair.
    // A half-applied state silently leaks events across PRs in production —
    // either through the broker (schema set, no tag) or through the DB
    // (tag set, no schema). Fail startup loudly so the misconfiguration
    // can't make it past first boot.
    const previewTag = (process.env.EVENT_PREVIEW_TAG ?? '').trim();
    const hasSchema = schema !== null;
    const hasTag = previewTag !== '';
    if (hasSchema && !hasTag) {
        throw new Error(
            `createOutboxPool: DATABASE_URL contains ?schema=${schema} but EVENT_PREVIEW_TAG is unset. ` +
                'Schema-per-PR isolation is a preview-only feature; running it without EVENT_PREVIEW_TAG would publish to the canonical RabbitMQ exchange while reading from a per-PR DB schema, leaking events across PRs. ' +
                'Either set EVENT_PREVIEW_TAG=<your-preview-id> alongside the schema, or remove ?schema= from DATABASE_URL.',
        );
    }
    if (!hasSchema && hasTag) {
        throw new Error(
            `createOutboxPool: EVENT_PREVIEW_TAG=${previewTag} is set but DATABASE_URL has no ?schema=. ` +
                'RabbitMQ traffic is being routed to a tagged exchange but DB writes will hit the default schema, leaking outbox rows across PRs. ' +
                'Either add ?schema=<your-pr-schema> to DATABASE_URL, or unset EVENT_PREVIEW_TAG.',
        );
    }

    return new Pool({
        connectionString: databaseUrl,
        max: opts.max ?? 4,
        ...(schema ? { options: `-c search_path=${schema}` } : {}),
        ...opts.poolOverrides,
    });
}

function truncate(s: string): string {
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

export type IndexAssertMode = 'throw' | 'warn' | 'off';

interface OutboxIndexRow {
    indexname: string;
    indexdef: string;
    indisvalid: boolean;
}

function isPartialUnpublishedIndex(row: OutboxIndexRow): boolean {
    return row.indisvalid && row.indexdef.includes('WHERE (published_at IS NULL)');
}

/**
 * Verify outbox_event carries a valid partial index on (occurred_at) WHERE
 * published_at IS NULL — without it, OutboxRelay's poll query seq-scans the
 * whole table every tick (iac#719). Scoped to `current_schema()` so a
 * per-PR preview schema is checked independently of the canonical one, same
 * scope as the coherence assert above.
 *
 * `mode: 'throw'` (OutboxRelay's default) fails startup with the exact DDL
 * to run. `'warn'` logs at error level and continues. `'off'` skips the
 * check. A same-named index that exists but is non-partial or INVALID always
 * gets the repair DDL, never the plain create DDL — `CREATE ... IF NOT
 * EXISTS` against that name is a no-op.
 */
export async function assertOutboxIndexHealth(
    pool: Pool,
    logger: ILogger,
    mode: IndexAssertMode = 'throw',
): Promise<void> {
    if (mode === 'off') return;

    const { rows } = await pool.query<OutboxIndexRow>(
        `SELECT c.relname AS indexname, pg_get_indexdef(ix.indexrelid) AS indexdef, ix.indisvalid
         FROM pg_index ix
         JOIN pg_class c ON c.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE t.relname = 'outbox_event' AND n.nspname = current_schema()`,
    );

    const healthy = rows.some(isPartialUnpublishedIndex);
    const legacy = rows.find((r) => r.indexname === OUTBOX_UNPUBLISHED_INDEX_NAME);
    const legacyBroken = legacy !== undefined && !isPartialUnpublishedIndex(legacy);

    if (!healthy) {
        const ddl = legacyBroken ? OUTBOX_UNPUBLISHED_INDEX_REPAIR_SQL : OUTBOX_UNPUBLISHED_INDEX_SQL;
        const message =
            'outbox_event has no valid partial index on (occurred_at) WHERE published_at IS NULL ' +
            `— the relay's poll query will seq-scan the table. Run:\n${ddl}`;
        if (mode === 'throw') {
            throw new Error(message);
        }
        logger.error(`[assertOutboxIndexHealth] ${message}`);
        return;
    }

    if (legacyBroken) {
        logger.warn(
            `[assertOutboxIndexHealth] a valid partial index exists, but the legacy non-partial/invalid ` +
                `${OUTBOX_UNPUBLISHED_INDEX_NAME} is still present. Drop it once the replacement is confirmed ` +
                `in use: DROP INDEX CONCURRENTLY IF EXISTS ${OUTBOX_UNPUBLISHED_INDEX_NAME};`,
        );
    }
}
