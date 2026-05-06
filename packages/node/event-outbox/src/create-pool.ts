import { Pool, type PoolConfig } from 'pg';

export interface CreateOutboxPoolOpts {
    /**
     * Max connections in the dedicated relay pool. Defaults to 2 — the relay
     * needs only one for the polling tick + one spare for liveness checks. Keep
     * it small so it cannot starve request-path Prisma traffic, especially in
     * preview environments where many PRs share a single Postgres instance.
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
 * `new Pool({ connectionString, max: 2 })`. The startup coherence assert
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
        max: opts.max ?? 2,
        ...(schema ? { options: `-c search_path=${schema}` } : {}),
        ...opts.poolOverrides,
    });
}

function truncate(s: string): string {
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
