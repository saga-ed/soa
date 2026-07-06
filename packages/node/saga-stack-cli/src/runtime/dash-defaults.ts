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
import type { ServiceId } from '../core/manifest/index.js';

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

/**
 * The dash service-key → manifest `ServiceId` whose localhost port backs it (M7
 * stack-lane slot config). Same key set as `DASH_TUNNEL_LABELS`; `program-hub` and
 * `enrollment-api` both resolve to programs-api, `connect` to connect-api. Used to
 * WRITE a slot's `config.local.json` pointing each dash service at its offset
 * localhost port (else the dash's built-in defaults hit slot 0's base ports).
 */
export const DASH_LOCAL_SERVICES: Readonly<Record<string, ServiceId>> = {
  iam: 'iam-api',
  'program-hub': 'programs-api',
  'enrollment-api': 'programs-api',
  'scheduling-api': 'scheduling-api',
  'sessions-api': 'sessions-api',
  'sis-api': 'sis-api',
  'content-api': 'content-api',
  connect: 'connect-api',
  // The browser dials these two for REAL (the dash's attendance/transcripts tRPC
  // clients), so a slot's config.local.json MUST offset them too — else a slot > 0
  // dash keeps the base config.json ports (ads-adm 5005 / transcripts 6302 = SLOT
  // 0's services) and a stage-7 attendance WRITE silently corrupts slot 0's
  // ads-adm projection. ads-adm-api is SLOTTABLE now (tokenized env +
  // EXPRESS_SERVER_PORT injection), so the offset port (6005 at slot 1) is the
  // slot's OWN ads-adm-api; transcripts-api remains excluded at slot > 0, where
  // its offset port has nothing listening ⇒ that call fails LOUD (connection
  // refused) instead of writing cross-slot — the corruption gate.
  'ads-adm': 'ads-adm-api',
  'transcripts-api': 'transcripts-api',
};

/** Inputs to the dash-defaults prelaunch hook. */
export interface DashDefaultsContext {
  /** Resolved saga-dash repo root (`resolveRepoRoot('SAGA_DASH', ctx)`). */
  sagaDashRoot: string;
  /** True iff running in `--tunnel` mode. Default false (the native partial-stack default). */
  tunnel?: boolean;
  /** `<moniker>.<VMS_BASE>` — required when `tunnel` is true. */
  tunnelDomain?: string;
  /**
   * Stack instance slot (M7). > 0 ⇒ stack-lane WRITE mode: emit a
   * `config.local.json` pointing each dash service at its OFFSET localhost port
   * (`stackPorts`), instead of removing the file (which would fall back to the
   * dash's base-port defaults = slot 0's iam). Default 0 (or absent) ⇒ the
   * pre-M7 remove/no-op behaviour, byte-identical.
   */
  slot?: number;
  /**
   * Resolved per-service localhost ports for the slot's stack-lane dash config
   * (a slot's `InstanceProfile.portOverrides` / the launch context's `ports`).
   * Required for the slot > 0 stack-lane write.
   */
  stackPorts?: Partial<Record<ServiceId, number>>;
}

/** What the hook did, for `emit()` / logging. */
export interface DashSyncResult {
  action: 'removed' | 'wrote' | 'wrote-stack-slot' | 'noop-no-static' | 'noop-absent';
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
 * Build the stack-lane SLOT `config.local.json` contents: each dash service key →
 * `http://localhost:<offset port>` (2-space JSON + trailing newline, same shape as
 * the tunnel writer). A dash key whose backing service has no resolved port is
 * omitted rather than emitting `localhost:undefined`.
 */
export function stackSlotConfigContents(stackPorts: Partial<Record<ServiceId, number>>): string {
  const localDefaults: Record<string, { type: 'url'; url: string }> = {};
  for (const [key, svc] of Object.entries(DASH_LOCAL_SERVICES)) {
    const port = stackPorts[svc];
    if (port === undefined) continue;
    localDefaults[key] = { type: 'url', url: `http://localhost:${port}` };
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

  // Non-tunnel (stack lane):
  if (!ctx.tunnel) {
    // M7 slot > 0: WRITE the offset-localhost config so the slot's dash dials its
    // own ports (removing the file would fall back to the base-port = slot-0 iam).
    if ((ctx.slot ?? 0) > 0 && ctx.stackPorts) {
      fs.write(cfgPath, stackSlotConfigContents(ctx.stackPorts));
      return { action: 'wrote-stack-slot', path: cfgPath };
    }
    // Slot 0: localhost defaults — remove any stale tunnel config (byte-identical).
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
