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
 * In production the Prisma URL has no `?schema=…`, the `options` are unset,
 * and the helper behaves like a plain `new Pool({ connectionString })`.
 *
 * Throws if `databaseUrl` is not a parseable URL or if the `schema` value
 * contains characters outside the Postgres unquoted-identifier set
 * (`[A-Za-z_][A-Za-z0-9_]*`). The connection-string form (`host=… dbname=…`)
 * is not supported — pass a URL.
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
