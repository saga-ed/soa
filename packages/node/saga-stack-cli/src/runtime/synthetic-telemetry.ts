import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import type { RepoKey } from '../core/manifest/index.js';
import type { SyntheticTelemetry } from '../core/telemetry.js';

/** Opt-in only: normal ss launches retain their existing telemetry behavior. */
export function readSyntheticTelemetry(
  repoRoots: Record<RepoKey, string>,
  env: NodeJS.ProcessEnv = process.env,
): SyntheticTelemetry | undefined {
  if (env.SS_TELEMETRY !== 'datadog') return undefined;
  const machine = env.SS_TELEMETRY_MACHINE ?? hostname().toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(machine)) throw new Error('Invalid SS_TELEMETRY_MACHINE');
  const endpoint = env.SS_TELEMETRY_ENDPOINT ?? 'http://127.0.0.1:4318';
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SS_TELEMETRY_ENDPOINT must be a loopback HTTP OTLP base URL');
  }
  const versions: Partial<Record<RepoKey, string>> = {};
  for (const [key, root] of Object.entries(repoRoots)) {
    try {
      const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      versions[key as RepoKey] = `${revision}${dirty ? '-dirty' : ''}`;
    } catch { /* Missing optional repositories have no asserted revision. */ }
  }
  return { machine, endpoint: url.origin, versions };
}
