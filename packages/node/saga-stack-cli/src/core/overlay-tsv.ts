/**
 * overlay-tsv — the PURE parser for the personal overlay file
 * (`integration-suite.local.tsv`), M10.
 *
 * The file is one row per repo: `<repo><TAB><comma-separated PR#s/branches>`.
 * refresh-suite.sh reads it with `grep -vE '^\s*(#|$)'` (drop comment + blank/
 * whitespace-only lines) piped into `while IFS=$'\t' read -r repo prs` (split on the
 * FIRST tab; the rest is the PR set), then whitespace-strips both fields
 * (`${repo//[[:space:]]/}` / `${prs//[[:space:]]/}`). This is a byte-faithful port of
 * that filtering + splitting.
 *
 * PURITY: no fs — the runtime reads the file text (a one-line `readFileSync` behind an
 * injectable seam) and hands the STRING here. `src/core/**` never touches IO.
 */

/** One parsed overlay row: a repo name and its (whitespace-stripped) PR/branch set. */
export interface OverlayRow {
  /** Repo name (whitespace-stripped), e.g. `saga-dash`. */
  repo: string;
  /** Comma-separated PR#s / branch names (whitespace-stripped), e.g. `410,432` (may be `''`). */
  prs: string;
}

/**
 * Parse the overlay-file text into rows, reproducing refresh-suite.sh exactly:
 *   - `grep -vE '^\s*(#|$)'` — skip comment lines (optional leading whitespace then `#`)
 *     and blank/whitespace-only lines.
 *   - `IFS=$'\t' read -r repo prs` — split on the FIRST tab; everything after is the PR
 *     set (later tabs are absorbed into `prs`, then stripped below).
 *   - `${repo//[[:space:]]/}` / `${prs//[[:space:]]/}` — strip ALL whitespace from each.
 *   - `[[ -z "$repo" ]] && continue` — a row whose repo is empty after stripping is dropped.
 * A row with a repo but an empty PR set is KEPT (`prs: ''`) — the caller decides what to
 * do with it (list prints it; apply skips it with a "no PRs listed" note).
 */
export function parseOverlayTsv(text: string): OverlayRow[] {
  const rows: OverlayRow[] = [];
  for (const line of text.split('\n')) {
    // grep -vE '^\s*(#|$)': comment or blank/whitespace-only ⇒ skip.
    if (/^\s*(#|$)/.test(line)) continue;
    // read -r repo prs with IFS=tab: first tab splits; the remainder is prs.
    const body = line.replace(/^\s+/, ''); // IFS=tab treats a leading tab/space as whitespace, not an empty field
    const tab = body.indexOf('\t');
    const repoRaw = tab === -1 ? body : body.slice(0, tab);
    const prsRaw = tab === -1 ? '' : body.slice(tab + 1);
    const repo = repoRaw.replace(/\s/g, '');
    const prs = prsRaw.replace(/\s/g, '');
    if (repo === '') continue;
    rows.push({ repo, prs });
  }
  return rows;
}
