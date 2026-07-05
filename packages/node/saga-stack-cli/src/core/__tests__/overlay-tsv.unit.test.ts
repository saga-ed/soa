/**
 * overlay-tsv parser unit tests (M10) — the byte-faithful port of refresh-suite.sh's
 * `grep -vE '^\s*(#|$)'` + `IFS=$'\t' read -r repo prs` + whitespace-strip.
 */

import { describe, expect, it } from 'vitest';
import { parseOverlayTsv } from '../overlay-tsv.js';

describe('parseOverlayTsv', () => {
  it('parses <repo>\\t<prs> rows', () => {
    expect(parseOverlayTsv('rostering\t410,432\nsaga-dash\t165')).toEqual([
      { repo: 'rostering', prs: '410,432' },
      { repo: 'saga-dash', prs: '165' },
    ]);
  });

  it('skips comment lines (optional leading whitespace then #) and blank/whitespace-only lines', () => {
    const text = ['# a header comment', '   # indented comment', '', '   ', '\t', 'saga-dash\t165'].join('\n');
    expect(parseOverlayTsv(text)).toEqual([{ repo: 'saga-dash', prs: '165' }]);
  });

  it('strips ALL whitespace from both fields (${repo//[[:space:]]/} / ${prs//[[:space:]]/})', () => {
    expect(parseOverlayTsv(' rostering \t 410, 432 ')).toEqual([{ repo: 'rostering', prs: '410,432' }]);
  });

  it('keeps a repo row with an EMPTY pr set (prs: "") — caller decides', () => {
    expect(parseOverlayTsv('rostering\t')).toEqual([{ repo: 'rostering', prs: '' }]);
    expect(parseOverlayTsv('rostering')).toEqual([{ repo: 'rostering', prs: '' }]);
  });

  it('treats a leading tab as IFS-whitespace (not an empty field), matching bash `IFS=$\'\\t\' read`', () => {
    // bash `IFS=$'\t' read -r repo prs` ignores a leading tab → repo=165 (not dropped);
    // and `\tsaga-dash\t165` → repo=saga-dash, prs=165. We strip leading ws before splitting.
    expect(parseOverlayTsv('\t165')).toEqual([{ repo: '165', prs: '' }]);
    expect(parseOverlayTsv('\tsaga-dash\t165')).toEqual([{ repo: 'saga-dash', prs: '165' }]);
  });

  it('drops a row that is empty/whitespace-only (no repo at all)', () => {
    expect(parseOverlayTsv('\t\t')).toEqual([]);
  });

  it('splits on the FIRST tab; later tabs fold into prs then strip away', () => {
    expect(parseOverlayTsv('saga-dash\t165\t999')).toEqual([{ repo: 'saga-dash', prs: '165999' }]);
  });

  it('empty text ⇒ no rows', () => {
    expect(parseOverlayTsv('')).toEqual([]);
  });
});
