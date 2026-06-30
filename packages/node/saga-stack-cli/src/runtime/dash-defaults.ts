/**
 * The `sync-dash-local-defaults` prelaunch hook (plan §7.2 "M4"; manifest
 * `ServiceDef.prelaunchHook`). A FAITHFUL port of up.sh's
 * `sync_dash_local_defaults` (~1331-1355) — `services_up`'s FIRST action, run
 * before saga-dash (re)launches because the dash reads `static/config.local.json`
 * at page load, so the file must match the run mode first.
 *
 * Behaviour, mode for mode with up.sh:
 *   - No `static/` dir (saga-dash not checked out at the resolved path) ⇒ no-op.
 *   - NOT tunnel mode (the native partial-stack default) ⇒ REMOVE
 *     `config.local.json` if present, so the dash falls back to its localhost
 *     defaults. Idempotent: absent file ⇒ clean no-op.
 *   - Tunnel mode ⇒ WRITE `config.local.json` mapping each dash service key to
 *     `https://<label>.<TUNNEL_DOMAIN>` (the exact key→label map from up.sh's
 *     inline node script), 2-space-indented JSON + trailing newline.
 *
 * The fs (dir-exists / file-exists / write / remove) is behind the injectable
 * `DashFs` so the hook is unit-tested with NO real filesystem; production wires
 * `makeRealDashFs()`. This is runtime (fs IO), not core.
 *
 * INVARIANT (plan hard constraint): fs IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The dash service-key → tunnel host-label map (verbatim from up.sh's inline
 * node script). Note `program-hub` and `enrollment-api` BOTH map to `programs`,
 * preserved exactly.
 */
export const DASH_TUNNEL_LABELS: Readonly<Record<string, string>> = {
  iam: 'iam',
  'program-hub': 'programs',
  'enrollment-api': 'programs',
  'scheduling-api': 'scheduling',
  'sessions-api': 'sessions',
  'sis-api': 'sis',
  'content-api': 'content',
  connect: 'connect',
};

/** Inputs to the dash-defaults prelaunch hook. */
export interface DashDefaultsContext {
  /** Resolved saga-dash repo root (`resolveRepoRoot('SAGA_DASH', ctx)`). */
  sagaDashRoot: string;
  /** True iff running in `--tunnel` mode. Default false (the native partial-stack default). */
  tunnel?: boolean;
  /** `<moniker>.<VMS_BASE>` — required when `tunnel` is true. */
  tunnelDomain?: string;
}

/** What the hook did, for `emit()` / logging. */
export interface DashSyncResult {
  action: 'removed' | 'wrote' | 'noop-no-static' | 'noop-absent';
  /** The config.local.json path acted on (when applicable). */
  path?: string;
}

/** Injectable fs surface for the hook (defaulted to real `node:fs`). */
export interface DashFs {
  existsDir(path: string): boolean;
  existsFile(path: string): boolean;
  remove(path: string): void;
  write(path: string, contents: string): void;
}

/** Relative path of the dash static config dir under the saga-dash repo root. */
const STATIC_REL = join('apps', 'web', 'dash', 'static');

/** Absolute path to the dash `config.local.json` under a saga-dash root. */
export function dashLocalConfigPath(sagaDashRoot: string): string {
  return join(sagaDashRoot, STATIC_REL, 'config.local.json');
}

/** Build the tunnel-mode `config.local.json` contents (2-space JSON + trailing newline). */
export function tunnelConfigContents(tunnelDomain: string): string {
  const localDefaults: Record<string, { type: 'url'; url: string }> = {};
  for (const [key, label] of Object.entries(DASH_TUNNEL_LABELS)) {
    localDefaults[key] = { type: 'url', url: `https://${label}.${tunnelDomain}` };
  }
  return `${JSON.stringify({ localDefaults }, null, 2)}\n`;
}

/**
 * Run the prelaunch hook. Pure-decision over the injectable `DashFs`, so it's
 * fully testable; returns what it did. In tunnel mode without a `tunnelDomain`
 * the write is skipped (treated as `noop-absent`) rather than emitting a broken
 * `https://<label>.undefined` config.
 */
export function syncDashLocalDefaults(
  ctx: DashDefaultsContext,
  fs: DashFs = makeRealDashFs(),
): DashSyncResult {
  const staticDir = join(ctx.sagaDashRoot, STATIC_REL);
  if (!fs.existsDir(staticDir)) return { action: 'noop-no-static' };

  const cfgPath = dashLocalConfigPath(ctx.sagaDashRoot);

  // Non-tunnel: localhost defaults — remove any stale tunnel config.
  if (!ctx.tunnel) {
    if (fs.existsFile(cfgPath)) {
      fs.remove(cfgPath);
      return { action: 'removed', path: cfgPath };
    }
    return { action: 'noop-absent', path: cfgPath };
  }

  // Tunnel: write the <svc>→https://<label>.<domain> map.
  if (!ctx.tunnelDomain) return { action: 'noop-absent', path: cfgPath };
  fs.write(cfgPath, tunnelConfigContents(ctx.tunnelDomain));
  return { action: 'wrote', path: cfgPath };
}

/** The production fs surface for the hook. */
export function makeRealDashFs(): DashFs {
  return {
    existsDir: (path: string) => existsSync(path),
    existsFile: (path: string) => existsSync(path),
    remove: (path: string) => rmSync(path, { force: true }),
    write: (path: string, contents: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
  };
}
