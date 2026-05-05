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
     * the defaults derived from `databaseUrl`.
     */
    poolOverrides?: Partial<PoolConfig>;
}

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
 * @example
 *   const pool = createOutboxPool(process.env.DATABASE_URL!);
 *   const relay = new OutboxRelay({ pool, ...rest });
 */
export function createOutboxPool(
    databaseUrl: string,
    opts: CreateOutboxPoolOpts = {},
): Pool {
    const url = new URL(databaseUrl);
    const schema = url.searchParams.get('schema');
    const max = opts.max ?? 2;

    return new Pool({
        connectionString: databaseUrl,
        max,
        ...(schema ? { options: `-c search_path=${schema}` } : {}),
        ...opts.poolOverrides,
    });
}
