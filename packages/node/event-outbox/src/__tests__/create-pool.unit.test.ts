import { describe, expect, it } from 'vitest';
import { createOutboxPool } from '../create-pool.js';

// We verify the pool's `options` resolve correctly without opening a real
// connection. `pg.Pool` exposes a public `options` property that reflects
// the merged config — that's what the relay (and libpq) will use when a
// client is checked out.

interface PoolWithOptions {
    options?: { connectionString: string; max: number; options?: string };
}

function getOpts(pool: unknown): { connectionString: string; max: number; options?: string } {
    const opts = (pool as PoolWithOptions).options;
    if (!opts) throw new Error('pool.options not exposed');
    return opts;
}

describe('createOutboxPool', () => {
    it('passes connectionString through', () => {
        const url = 'postgresql://u:p@h:5432/db';
        const pool = createOutboxPool(url);
        expect(getOpts(pool).connectionString).toBe(url);
    });

    it('defaults max to 2', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db');
        expect(getOpts(pool).max).toBe(2);
    });

    it('respects an explicit max', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db', { max: 5 });
        expect(getOpts(pool).max).toBe(5);
    });

    it('does not set libpq options when no schema param is present', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db');
        expect(getOpts(pool).options).toBeUndefined();
    });

    it('translates ?schema=… into libpq search_path', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db?schema=pr_142',
        );
        expect(getOpts(pool).options).toBe('-c search_path=pr_142');
    });

    it('handles other URL params alongside schema', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db?sslmode=require&schema=pr_142',
        );
        expect(getOpts(pool).options).toBe('-c search_path=pr_142');
    });

    it('poolOverrides win over defaults but do not strip the search_path option', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db?schema=pr_7',
            { poolOverrides: { idleTimeoutMillis: 30_000 } },
        );
        const opts = getOpts(pool);
        expect(opts.options).toBe('-c search_path=pr_7');
        expect((opts as { idleTimeoutMillis?: number }).idleTimeoutMillis).toBe(30_000);
    });

    it('explicit options in poolOverrides win — escape hatch for advanced cases', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db?schema=pr_7',
            { poolOverrides: { options: '-c statement_timeout=5000' } },
        );
        expect(getOpts(pool).options).toBe('-c statement_timeout=5000');
    });

    it('poolOverrides.max wins over the top-level max option', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db',
            { max: 2, poolOverrides: { max: 8 } },
        );
        expect(getOpts(pool).max).toBe(8);
    });

    it('treats present-but-empty ?schema= the same as absent', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db?schema=');
        expect(getOpts(pool).options).toBeUndefined();
    });

    it('throws on a non-URL connection string with a useful message', () => {
        // libpq KV form ("host=… dbname=…") and other non-URL strings are not
        // supported. We surface a helpful error rather than letting URL throw
        // a raw TypeError that points at the wrong line.
        expect(() => createOutboxPool('host=/var/run dbname=app')).toThrow(
            /URL-form connection string/,
        );
        expect(() => createOutboxPool('not a url')).toThrow(/URL-form/);
    });

    it('rejects a schema name with spaces or special chars (libpq injection guard)', () => {
        // A schema value of ` pr_142 -c statement_timeout=0` would inject a
        // second startup parameter via the `-c search_path=…` form. The
        // identifier-regex check forbids it.
        expect(() =>
            createOutboxPool('postgresql://u:p@h/db?schema=pr_142%20-c%20statement_timeout%3D0'),
        ).toThrow(/unquoted-identifier|safely interpolated/i);

        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=foo%3Bbar')).toThrow(
            /safely interpolated/i,
        );
    });

    it('accepts hyphen-free schema names that match Postgres unquoted identifiers', () => {
        // pr_142 (underscore) and Pr142 (mixed case) both pass.
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=pr_142')).not.toThrow();
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=Pr142')).not.toThrow();
    });
});
