import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

// The coherence assert ties `?schema=` in DATABASE_URL to EVENT_PREVIEW_TAG.
// Tests that exercise schema-aware paths must set the tag; tests that
// exercise the production path must clear it. A beforeEach/afterEach pair
// snapshots the env so test order doesn't matter.
const ORIGINAL_TAG = process.env.EVENT_PREVIEW_TAG;

function restoreTag(): void {
    if (ORIGINAL_TAG === undefined) {
        delete process.env.EVENT_PREVIEW_TAG;
    } else {
        process.env.EVENT_PREVIEW_TAG = ORIGINAL_TAG;
    }
}

describe('createOutboxPool — production-shape URLs (no schema, no tag)', () => {
    beforeEach(() => {
        delete process.env.EVENT_PREVIEW_TAG;
    });
    afterEach(restoreTag);

    it('passes connectionString through', () => {
        const url = 'postgresql://u:p@h:5432/db';
        const pool = createOutboxPool(url);
        expect(getOpts(pool).connectionString).toBe(url);
    });

    it('defaults max to 4', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db');
        expect(getOpts(pool).max).toBe(4);
    });

    it('respects an explicit max', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db', { max: 5 });
        expect(getOpts(pool).max).toBe(5);
    });

    it('does not set libpq options when no schema param is present', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db');
        expect(getOpts(pool).options).toBeUndefined();
    });

    it('treats present-but-empty ?schema= the same as absent', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db?schema=');
        expect(getOpts(pool).options).toBeUndefined();
    });

    it('poolOverrides.max wins over the top-level max option', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db', {
            max: 2,
            poolOverrides: { max: 8 },
        });
        expect(getOpts(pool).max).toBe(8);
    });
});

describe('createOutboxPool — preview-shape URLs (schema + matching tag)', () => {
    beforeEach(() => {
        process.env.EVENT_PREVIEW_TAG = 'pr-42';
    });
    afterEach(restoreTag);

    it('translates ?schema=… into libpq search_path', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db?schema=pr_142');
        expect(getOpts(pool).options).toBe('-c search_path=pr_142');
    });

    it('handles other URL params alongside schema', () => {
        const pool = createOutboxPool(
            'postgresql://u:p@h:5432/db?sslmode=require&schema=pr_142',
        );
        expect(getOpts(pool).options).toBe('-c search_path=pr_142');
    });

    it('accepts the exact adopter URL form (?schema= AND ?options= belt-and-suspenders)', () => {
        // Adopters' GitHub workflows emit URLs with both params filled in:
        //   ?schema=pr_42&options=-c%20search_path%3Dpr_42
        // The helper parses ?schema=, sets top-level `options` to the same
        // value (overriding the URL's `?options=` carried via connectionString).
        // No throw; the URL is preserved verbatim so callers can later opt out
        // of the top-level options via poolOverrides if needed.
        const url =
            'postgresql://u:p@h:5432/db?schema=pr_42&options=-c%20search_path%3Dpr_42';
        const pool = createOutboxPool(url);
        const opts = getOpts(pool);
        expect(opts.options).toBe('-c search_path=pr_42');
        expect(opts.connectionString).toBe(url);
    });

    it('poolOverrides win over defaults but do not strip the search_path option', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db?schema=pr_7', {
            poolOverrides: { idleTimeoutMillis: 30_000 },
        });
        const opts = getOpts(pool);
        expect(opts.options).toBe('-c search_path=pr_7');
        expect((opts as { idleTimeoutMillis?: number }).idleTimeoutMillis).toBe(30_000);
    });

    it('explicit options in poolOverrides win — escape hatch for advanced cases', () => {
        const pool = createOutboxPool('postgresql://u:p@h:5432/db?schema=pr_7', {
            poolOverrides: { options: '-c statement_timeout=5000' },
        });
        expect(getOpts(pool).options).toBe('-c statement_timeout=5000');
    });

    it('accepts hyphen-free schema names that match Postgres unquoted identifiers', () => {
        // pr_142 (underscore) and Pr142 (mixed case) both pass.
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=pr_142')).not.toThrow();
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=Pr142')).not.toThrow();
    });
});

describe('createOutboxPool — input validation', () => {
    beforeEach(() => {
        // Tests in this group fail before reaching the coherence assert;
        // env-var state is irrelevant. Clear it for predictability.
        delete process.env.EVENT_PREVIEW_TAG;
    });
    afterEach(restoreTag);

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
        // identifier-regex check forbids it. Set the tag so we hit the regex
        // check (not the coherence assert).
        process.env.EVENT_PREVIEW_TAG = 'pr-42';
        expect(() =>
            createOutboxPool(
                'postgresql://u:p@h/db?schema=pr_142%20-c%20statement_timeout%3D0',
            ),
        ).toThrow(/unquoted-identifier|safely interpolated/i);

        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=foo%3Bbar')).toThrow(
            /safely interpolated/i,
        );
    });
});

describe('createOutboxPool — preview-isolation coherence assert', () => {
    afterEach(restoreTag);

    // Truth table — every cell is exercised. The assert exists because a
    // half-applied two-axis isolation model (DB schema-per-PR + RabbitMQ
    // tag-per-PR) silently leaks events across PRs, and the failure mode is
    // invisible until prod traffic hits it.

    it('passes when neither tag nor schema are set (production case)', () => {
        delete process.env.EVENT_PREVIEW_TAG;
        expect(() => createOutboxPool('postgresql://u:p@h/db')).not.toThrow();
    });

    it('passes when both tag AND schema are set (preview case)', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-42';
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=pr_42')).not.toThrow();
    });

    it('throws when ?schema= is set but EVENT_PREVIEW_TAG is unset', () => {
        delete process.env.EVENT_PREVIEW_TAG;
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=pr_42')).toThrow(
            /\?schema=pr_42 but EVENT_PREVIEW_TAG is unset/,
        );
    });

    it('throws when ?schema= is set but EVENT_PREVIEW_TAG is whitespace-only', () => {
        // Trim semantics match applyPreviewTag: a whitespace-only tag is
        // treated as unset (otherwise it would silently route to a bogus
        // `<exchange>.   ` queue).
        process.env.EVENT_PREVIEW_TAG = '   ';
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=pr_42')).toThrow(
            /EVENT_PREVIEW_TAG is unset/,
        );
    });

    it('throws when EVENT_PREVIEW_TAG is set but ?schema= is absent', () => {
        process.env.EVENT_PREVIEW_TAG = 'pr-42';
        expect(() => createOutboxPool('postgresql://u:p@h/db')).toThrow(
            /EVENT_PREVIEW_TAG=pr-42.*no \?schema=/s,
        );
    });

    it('throws when EVENT_PREVIEW_TAG is set but ?schema= is present-but-empty', () => {
        // Treated as absent — same as the no-schema case. Symmetric with the
        // "treats present-but-empty ?schema= the same as absent" production case.
        process.env.EVENT_PREVIEW_TAG = 'pr-42';
        expect(() => createOutboxPool('postgresql://u:p@h/db?schema=')).toThrow(
            /no \?schema=/,
        );
    });
});
