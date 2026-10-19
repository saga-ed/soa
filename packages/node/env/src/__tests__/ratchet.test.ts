import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RATCHET_RULE_ID,
  compareToBaseline,
  countByFile,
  runRatchet,
  type RatchetDeps,
} from '../eslint/index.js';

const CWD = '/repo';
const hit = (file: string, n: number, ruleId = RATCHET_RULE_ID) => ({
  filePath: path.join(CWD, file),
  messages: Array.from({ length: n }, () => ({ ruleId })),
});
const baseline = (entries: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(entries).map(([f, count]) => [f, { [RATCHET_RULE_ID]: { count } }])
  );

interface Harness {
  deps: RatchetDeps;
  out: string[];
  err: string[];
  files: Map<string, string>;
  eslintCalls: [string, string[]][];
}

function harness(
  opts: { eslint?: unknown; baseline?: unknown; env?: Record<string, string> } = {}
): Harness {
  const files = new Map<string, string>();
  if (opts.baseline !== undefined)
    files.set('/repo/soa-env-baseline.json', JSON.stringify(opts.baseline));
  const out: string[] = [];
  const err: string[] = [];
  const eslintCalls: [string, string[]][] = [];
  return {
    out,
    err,
    files,
    eslintCalls,
    deps: {
      cwd: CWD,
      env: opts.env ?? {},
      readFile: f => {
        const text = files.get(f);
        if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return text;
      },
      writeFile: (f, d) => void files.set(f, d),
      runEslint: (cmd, args) => {
        eslintCalls.push([cmd, args]);
        return JSON.stringify(opts.eslint ?? []);
      },
      stdout: t => void out.push(t),
      stderr: t => void err.push(t),
    },
  };
}

describe('countByFile / compareToBaseline', () => {
  it('counts only this rule, per repo-relative file', () => {
    const counts = countByFile([hit('a.ts', 2), hit('b.ts', 1, 'no-console'), hit('c.ts', 0)], CWD);
    expect([...counts]).toEqual([['a.ts', 2]]);
  });

  it('passes when counts equal baseline', () => {
    expect(compareToBaseline(new Map([['a.ts', 2]]), baseline({ 'a.ts': 2 }))).toEqual([]);
  });

  it('fails above baseline, and new files have an implicit baseline of 0', () => {
    const f = compareToBaseline(
      new Map([
        ['a.ts', 3],
        ['new.ts', 1],
      ]),
      baseline({ 'a.ts': 2 })
    );
    expect(f).toEqual([
      'a.ts: new violation (3 found, baseline 2)',
      'new.ts: new violation (1 found, baseline 0)',
    ]);
  });

  it('fails below baseline as stale, including a file that dropped to zero', () => {
    const f = compareToBaseline(new Map([['a.ts', 1]]), baseline({ 'a.ts': 2, 'gone.ts': 4 }));
    expect(f).toEqual([
      'a.ts: baseline stale: lower it (1 found, baseline 2)',
      'gone.ts: baseline stale: lower it (0 found, baseline 4)',
    ]);
  });
});

describe('runRatchet', () => {
  it('exits 0 when counts match the baseline', () => {
    const h = harness({ eslint: [hit('a.ts', 2)], baseline: baseline({ 'a.ts': 2 }) });
    expect(runRatchet([], h.deps)).toBe(0);
    expect(h.eslintCalls).toEqual([['eslint', ['.']]]);
  });

  it('exits 1 above baseline (new violation)', () => {
    const h = harness({ eslint: [hit('a.ts', 3)], baseline: baseline({ 'a.ts': 2 }) });
    expect(runRatchet([], h.deps)).toBe(1);
    expect(h.err.join()).toMatch(/new violation/);
  });

  it('exits 1 below baseline with "baseline stale: lower it"', () => {
    const h = harness({ eslint: [hit('a.ts', 1)], baseline: baseline({ 'a.ts': 2 }) });
    expect(runRatchet([], h.deps)).toBe(1);
    expect(h.err.join()).toMatch(/baseline stale: lower it/);
  });

  it('treats a missing baseline as empty (every violation is new)', () => {
    const h = harness({ eslint: [hit('a.ts', 1)] });
    expect(runRatchet([], h.deps)).toBe(1);
    expect(runRatchet([], harness({ eslint: [] }).deps)).toBe(0);
  });

  it('--write regenerates the baseline outside CI', () => {
    const h = harness({
      eslint: [hit('b.ts', 1), hit('a.ts', 2)],
      baseline: baseline({ 'old.ts': 9 }),
    });
    expect(runRatchet(['--write'], h.deps)).toBe(0);
    expect(JSON.parse(h.files.get('/repo/soa-env-baseline.json') as string)).toEqual(
      baseline({ 'a.ts': 2, 'b.ts': 1 })
    );
    expect(runRatchet([], h.deps)).toBe(0);
  });

  it('--write is refused when CI is set and leaves the baseline untouched', () => {
    const h = harness({
      eslint: [hit('a.ts', 2)],
      baseline: baseline({ 'a.ts': 5 }),
      env: { CI: 'true' },
    });
    const before = h.files.get('/repo/soa-env-baseline.json');
    expect(runRatchet(['--write'], h.deps)).toBe(2);
    expect(h.err.join()).toMatch(/refused/);
    expect(h.files.get('/repo/soa-env-baseline.json')).toBe(before);
    expect(h.eslintCalls).toEqual([]);
  });

  it('consumes eslint JSON via --input and honours --baseline and paths', () => {
    const h = harness({ baseline: baseline({ 'a.ts': 1 }) });
    h.files.set('/in.json', JSON.stringify([hit('a.ts', 1)]));
    expect(runRatchet(['--input', '/in.json'], h.deps)).toBe(0);
    h.files.set('/repo/custom.json', JSON.stringify(baseline({ 'z.ts': 1 })));
    expect(runRatchet(['--baseline', 'custom.json', '--input', '/in.json'], h.deps)).toBe(1);
    const h2 = harness();
    runRatchet(['src', 'lib', '--eslint', 'e'], h2.deps);
    expect(h2.eslintCalls).toEqual([['e', ['src', 'lib']]]);
  });

  it('exits 2 on usage and runtime errors', () => {
    expect(runRatchet(['--bogus'], harness().deps)).toBe(2);
    expect(runRatchet(['--baseline'], harness().deps)).toBe(2);
    const h = harness();
    h.files.set('/in.json', 'not json');
    expect(runRatchet(['--input', '/in.json'], h.deps)).toBe(2);
  });
});
