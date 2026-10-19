import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RATCHET_RULE_ID = '@saga-ed/soa-env/no-env-identity';

export interface RatchetBaseline {
  [file: string]: { '@saga-ed/soa-env/no-env-identity': { count: number } };
}

interface EslintFileResult {
  filePath: string;
  messages: { ruleId: string | null }[];
}

export interface RatchetDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  readFile(file: string): string;
  writeFile(file: string, data: string): void;
  /** Runs `eslint --format json` and returns its stdout. */
  runEslint(command: string, args: string[]): string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const USAGE = `Usage: soa-env-lint-ratchet [--baseline <file>] [--input <eslint-json|->] [--eslint <cmd>] [--write] [paths...]

Compares per-file counts of ${RATCHET_RULE_ID} against a baseline.
  --baseline  baseline file (default: soa-env-baseline.json)
  --input     read \`eslint --format json\` output from a file (or - for stdin) instead of running eslint
  --eslint    eslint command to run (default: eslint); paths default to .
  --write     regenerate the baseline (refused when CI is set)
Exit: 0 ok, 1 ratchet failure, 2 usage or runtime error.`;

export function countByFile(results: EslintFileResult[], cwd: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const result of results) {
    const n = result.messages.filter(m => m.ruleId === RATCHET_RULE_ID).length;
    if (n === 0) continue;
    const rel = path.relative(cwd, result.filePath).split(path.sep).join('/');
    counts.set(rel, (counts.get(rel) ?? 0) + n);
  }
  return counts;
}

/** New files have an implicit baseline of 0. Returns one message per failing file; empty = pass. */
export function compareToBaseline(
  counts: ReadonlyMap<string, number>,
  baseline: RatchetBaseline
): string[] {
  const failures: string[] = [];
  const files = new Set([...counts.keys(), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const actual = counts.get(file) ?? 0;
    const allowed = baseline[file]?.[RATCHET_RULE_ID]?.count ?? 0;
    if (actual > allowed) {
      failures.push(`${file}: new violation (${actual} found, baseline ${allowed})`);
    } else if (actual < allowed) {
      failures.push(`${file}: baseline stale: lower it (${actual} found, baseline ${allowed})`);
    }
  }
  return failures;
}

function toBaseline(counts: ReadonlyMap<string, number>): RatchetBaseline {
  const baseline: RatchetBaseline = {};
  for (const file of [...counts.keys()].sort()) {
    baseline[file] = { [RATCHET_RULE_ID]: { count: counts.get(file) as number } };
  }
  return baseline;
}

function defaultRunEslint(command: string, args: string[]): string {
  const res = spawnSync(command, [...args, '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`eslint exited with status ${res.status}: ${res.stderr.trim().slice(0, 500)}`);
  }
  return res.stdout;
}

export function defaultDeps(env: RatchetDeps['env']): RatchetDeps {
  return {
    cwd: process.cwd(),
    env,
    readFile: file => readFileSync(file === '-' ? 0 : file, 'utf8'),
    writeFile: (file, data) => writeFileSync(file, data),
    runEslint: defaultRunEslint,
    stdout: t => void process.stdout.write(t),
    stderr: t => void process.stderr.write(t),
  };
}

export function runRatchet(argv: readonly string[], deps: RatchetDeps): number {
  let baselineFile = 'soa-env-baseline.json';
  let input: string | undefined;
  let eslintCommand = 'eslint';
  let write = false;
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--write') write = true;
    else if (arg === '--baseline' || arg === '--input' || arg === '--eslint') {
      const value = argv[++i];
      if (value === undefined) {
        deps.stderr(`${arg} needs a value\n${USAGE}\n`);
        return 2;
      }
      if (arg === '--baseline') baselineFile = value;
      else if (arg === '--input') input = value;
      else eslintCommand = value;
    } else if (arg === '--help' || arg === '-h') {
      deps.stdout(`${USAGE}\n`);
      return 0;
    } else if (arg.startsWith('-')) {
      deps.stderr(`unknown option ${arg}\n${USAGE}\n`);
      return 2;
    } else paths.push(arg);
  }

  if (write && deps.env['CI']) {
    deps.stderr(
      '--write is refused when CI is set; regenerate the baseline locally and commit it\n'
    );
    return 2;
  }

  try {
    const json =
      input !== undefined
        ? deps.readFile(input)
        : deps.runEslint(eslintCommand, paths.length ? paths : ['.']);
    const counts = countByFile(JSON.parse(json) as EslintFileResult[], deps.cwd);
    const baselinePath = path.resolve(deps.cwd, baselineFile);

    if (write) {
      deps.writeFile(baselinePath, `${JSON.stringify(toBaseline(counts), null, 2)}\n`);
      deps.stdout(`wrote ${baselineFile} (${counts.size} files)\n`);
      return 0;
    }

    let baseline: RatchetBaseline = {};
    try {
      baseline = JSON.parse(deps.readFile(baselinePath)) as RatchetBaseline;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const failures = compareToBaseline(counts, baseline);
    if (failures.length > 0) {
      deps.stderr(`${failures.join('\n')}\n`);
      return 1;
    }
    deps.stdout('ratchet ok\n');
    return 0;
  } catch (err) {
    deps.stderr(`soa-env-lint-ratchet: ${(err as Error).message}\n`);
    return 2;
  }
}
