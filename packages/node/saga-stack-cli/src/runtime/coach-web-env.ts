/**
 * The `coach-web-env` prelaunch hook (soa#300) — the coach-web analogue of the
 * saga-dash `sync-dash-local-defaults` hook (`dash-defaults.ts`), run right after
 * it in the facade's bring-up sequence, gated on coach-web being launchable.
 *
 * WHY: coach-web (a SvelteKit adapter-static SPA at `<coachRoot>/apps/web/coach-web`)
 * reads its `PUBLIC_*` URLs via `$env/static/public`, inlined at vite-dev start. Its
 * CHECKED-IN `.env` carries REMOTE defaults (`https://iam.wootdev.com`,
 * `https://login.wootdev.com`, `https://dash.wootdev.com`) plus the base coach-api port
 * (wrong at slot > 0), so an un-overridden browser boots against remote/wrong hosts →
 * the whoami fetch fails → coach-web renders a 503 "Unable to reach the sign-in
 * service" and NO route renders (the original soa#300).
 *
 * PRECEDENCE — the thing to get right before touching this file (soa#298, live-proved
 * over a real tunnel): for a `$env/static/public` var, `process.env` (the LAUNCH ENV)
 * WINS over `.env.local`, which wins over `.env`. An earlier version of this comment
 * claimed the launch env was ignored; a tunnel run disproved it — with the launch env
 * and `.env.local` set to DIFFERENT hosts, the served bundle carried the launch env's,
 * and only the vars ABSENT from the launch env fell through to `.env.local`.
 *
 * SO WHAT THIS HOOK ACTUALLY BUYS: `PUBLIC_LOGIN_URL` + `PUBLIC_DASHBOARD_URL` — the
 * two the launch env does NOT set, whose `.env` defaults are shared REMOTE hosts.
 * `PUBLIC_IAM_API_URL` / `PUBLIC_COACH_API_URL` are also written here, but the manifest
 * sets both (`core/manifest/services.ts`, `${IAM_URL}` / `${COACH_API_URL}`) and the
 * launch env outranks this file, so those two lines are a redundant fallback rather
 * than the operative fix. Do not "fix" a URL bug by editing them alone — check whether
 * the manifest or `tunnelOverlay()` sets the var first, because that is what wins.
 *
 * SCOPE: the local `stack` lane only. Under `--tunnel` every coach-web PUBLIC_ var is
 * set by `tunnelOverlay()` in the LAUNCH ENV (which outranks whatever is on disk here),
 * so the hook NO-OPS — mirroring how the dash hook keeps tunnel routing distinct.
 *
 * The fs (dir-exists / write / remove) is behind the injectable `CoachWebFs` so the
 * hook is unit-tested with NO real filesystem; production wires `makeRealCoachWebFs()`.
 * This is runtime (fs IO), not core.
 *
 * INVARIANT (plan hard constraint): fs IO lives only in `src/runtime/**`;
 * `src/core/**` never imports this and stays pure.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServiceId } from '../core/manifest/index.js';

/** Inputs to the coach-web-env prelaunch hook. */
export interface CoachWebEnvContext {
  /** Resolved coach-web app root (`<coachRoot>/apps/web/coach-web`). */
  coachWebRoot: string;
  /**
   * True iff running in `--tunnel` mode. Tunnel coach-web URLs are a separate
   * concern (public hosts), so the hook no-ops rather than writing localhost URLs.
   * Default false (the native partial-stack default).
   */
  tunnel?: boolean;
  /**
   * Stack instance slot (M7). Carried for parity/logging; the hook WRITES at every
   * slot (including 0) because the checked-in `.env` remote defaults break local
   * browser-testing at every slot. Default 0 (or absent).
   */
  slot?: number;
  /**
   * Resolved per-service localhost ports for the slot (the launch context's `ports`,
   * already OFFSET for the slot — exactly the map the dash hook writes). Each PUBLIC_
   * var is mapped to `http://localhost:<offset port>`.
   */
  stackPorts: Partial<Record<ServiceId, number>>;
}

/** What the hook did, for `emit()` / logging. */
export interface CoachWebSyncResult {
  action: 'wrote' | 'noop-tunnel' | 'noop-no-app';
  /** The `.env.local` path acted on (when applicable). */
  path?: string;
}

/** Injectable fs surface for the hook (defaulted to real `node:fs`). */
export interface CoachWebFs {
  existsDir(path: string): boolean;
  write(path: string, contents: string): void;
  remove(path: string): void;
}

/** Relative path of the gitignored env override under the coach-web app root. */
const ENV_LOCAL_REL = '.env.local';

/** Absolute path to the coach-web `.env.local` under a coach-web app root. */
export function coachWebEnvLocalPath(coachWebRoot: string): string {
  return join(coachWebRoot, ENV_LOCAL_REL);
}

/**
 * Build the per-slot `.env.local` contents: each coach-web `PUBLIC_*` url → this
 * slot's LOCAL mesh offset host. A PUBLIC_ line whose backing service has no resolved
 * port is omitted rather than emitting `localhost:undefined` (coach-web then falls
 * back to its `.env` default for that one var — never a broken URL). Trailing newline.
 *
 *   PUBLIC_IAM_API_URL   ← iam-api    (browser dials iam DIRECT for whoami)
 *   PUBLIC_COACH_API_URL ← coach-api  (the coach BFF)
 *   PUBLIC_DASHBOARD_URL ← saga-dash  (the "open dashboard" link)
 *   PUBLIC_LOGIN_URL     ← iam-api    (the whoami 401 challenge login lives at iam's /demo)
 *
 * PUBLIC_EMBED_ALLOWED_ORIGINS is deliberately LEFT ALONE — not needed for boot.
 */
export function coachWebEnvLocalContents(stackPorts: Partial<Record<ServiceId, number>>): string {
  const iam = stackPorts['iam-api'];
  const coachApi = stackPorts['coach-api'];
  const dash = stackPorts['saga-dash'];

  const header = [
    '# Generated per-slot by `ss` at coach-web launch (soa#300) — GITIGNORED, do not commit.',
    '# Overrides the checked-in `.env` REMOTE defaults so coach-web\'s browser boots',
    '# against the LOCAL ss mesh: SvelteKit inlines these PUBLIC_* vars at vite-dev',
    '# start, and `.env.local` wins over `.env`.',
  ];

  const vars: string[] = [];
  if (iam !== undefined) vars.push(`PUBLIC_IAM_API_URL=http://localhost:${iam}`);
  if (coachApi !== undefined) vars.push(`PUBLIC_COACH_API_URL=http://localhost:${coachApi}`);
  if (dash !== undefined) vars.push(`PUBLIC_DASHBOARD_URL=http://localhost:${dash}`);
  // PUBLIC_LOGIN_URL → iam locally: the whoami 401 challenge login URL is iam's /demo.
  if (iam !== undefined) vars.push(`PUBLIC_LOGIN_URL=http://localhost:${iam}`);

  return `${[...header, ...vars].join('\n')}\n`;
}

/**
 * Run the prelaunch hook. Pure-decision over the injectable `CoachWebFs`, so it's
 * fully testable; returns what it did.
 *   - Tunnel mode ⇒ no-op (public coach-web URLs are a separate concern).
 *   - No coach-web app dir at the resolved path ⇒ no-op.
 *   - Otherwise ⇒ WRITE `<coachWebRoot>/.env.local` with the slot's offset localhost URLs.
 */
export function syncCoachWebEnvLocal(
  ctx: CoachWebEnvContext,
  fs: CoachWebFs = makeRealCoachWebFs(),
): CoachWebSyncResult {
  // Tunnel: leave `.env` / any tunnel wiring alone — the public tunnel coach-web URLs
  // are a separate concern, not this local-mesh override.
  if (ctx.tunnel) return { action: 'noop-tunnel' };

  // coach-web not checked out at the resolved path ⇒ nothing to write.
  if (!fs.existsDir(ctx.coachWebRoot)) return { action: 'noop-no-app' };

  const path = coachWebEnvLocalPath(ctx.coachWebRoot);
  fs.write(path, coachWebEnvLocalContents(ctx.stackPorts));
  return { action: 'wrote', path };
}

/** The production fs surface for the hook. */
export function makeRealCoachWebFs(): CoachWebFs {
  return {
    existsDir: (path: string) => existsSync(path),
    write: (path: string, contents: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    remove: (path: string) => rmSync(path, { force: true }),
  };
}
