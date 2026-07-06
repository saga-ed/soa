/**
 * Tiny TTY-aware ANSI palette for human-readable command output.
 *
 * NO dependency (chalk et al. are overkill for five codes) and NO color when
 * it could corrupt machine consumption: enabled only when stdout is a TTY,
 * `NO_COLOR` is unset (https://no-color.org), and TERM isn't `dumb`. The
 * `--porcelain` / `--output-json` paths never call these helpers at all, and
 * tests never see codes (vitest's stdout is not a TTY) — so exact-pin string
 * assertions stay byte-stable.
 */

const enabled: boolean =
  Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

function wrap(code: string): (s: string) => string {
  return (s: string) => (enabled ? `[${code}m${s}[0m` : s);
}

export const green = wrap('32');
export const red = wrap('31');
export const yellow = wrap('33');
export const dim = wrap('2');
export const bold = wrap('1');

/** Exposed for tests (asserting the gate, not the codes). */
export function colorEnabled(): boolean {
  return enabled;
}
