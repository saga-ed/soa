/**
 * `parseRealTableRows` — the one piece of parsing in the hydrate lane, and the
 * thing that decides which tables get materialised and in WHAT COLUMN ORDER.
 *
 * Column order is load-bearing: scrubbed mode issues
 * `COPY (SELECT <cols> FROM view) TO STDOUT | COPY table (<cols>) FROM STDIN`,
 * so a reordering here would silently write each column's data into the wrong
 * column. The mirror-side query orders by `attnum` on the `_real` table (the
 * TARGET's shape), and this parser must preserve that.
 */

import { describe, expect, it } from 'vitest';
import { parseRealTableRows } from '../hydrate.js';

const US = '\u001f';
const rows = (...pairs: [string, string][]): string => pairs.map(([t, c]) => `${t}${US}${c}`).join('\n');

describe('parseRealTableRows', () => {
  it('groups columns per table and PRESERVES the emitted (attnum) order', () => {
    expect(
      parseRealTableRows(
        rows(['users', 'id'], ['users', 'email'], ['users', 'created_at'], ['groups', 'id'], ['groups', 'name']),
      ),
    ).toEqual([
      { table: 'users', columns: ['id', 'email', 'created_at'] },
      { table: 'groups', columns: ['id', 'name'] },
    ]);
  });

  it('is empty for an unscrubbed database (no _real tables at all)', () => {
    expect(parseRealTableRows('')).toEqual([]);
    expect(parseRealTableRows('\n\n')).toEqual([]);
  });

  it('tolerates a trailing newline (psql always emits one)', () => {
    expect(parseRealTableRows(`${rows(['user_pii', 'id'])}\n`)).toEqual([{ table: 'user_pii', columns: ['id'] }]);
  });

  it('splits on the UNIT SEPARATOR, so a column name containing a comma/pipe survives', () => {
    expect(parseRealTableRows(rows(['t', 'weird|name,col']))).toEqual([
      { table: 't', columns: ['weird|name,col'] },
    ]);
  });

  it('drops a malformed row rather than inventing a column', () => {
    expect(parseRealTableRows(`users${US}id\nno-separator-here\n`)).toEqual([
      { table: 'users', columns: ['id'] },
    ]);
  });
});
