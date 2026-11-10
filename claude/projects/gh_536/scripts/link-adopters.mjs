/** Pre-release local overlay: invoke with the two isolated adopter worktree paths. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const soa = fileURLToPath(new URL('../../../../', import.meta.url));
const repos = process.argv.slice(2);
assert.equal(repos.length, 2, 'Pass rostering and program-hub worktree paths');
for (const input of repos) {
  const repo = resolve(input);
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.ok(branch.startsWith('gh_537-'), 'Use an isolated I#537 worktree');
  const path = resolve(repo, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.pnpm ??= {};
  pkg.pnpm.overrides ??= {};
  for (const name of ['event-stats', 'event-consumer', 'event-outbox']) {
    const target = resolve(soa, 'packages/node', name);
    assert.ok(existsSync(resolve(target, 'dist/index.js')), `Build ${name} first`);
    pkg.pnpm.overrides[`@saga-ed/soa-${name}`] = `link:${relative(repo, target)}`;
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`Linked three telemetry packages in ${repo}; run pnpm install --no-frozen-lockfile there. Keep root package.json and pnpm-lock.yaml overlay changes local.`);
}
