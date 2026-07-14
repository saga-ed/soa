/**
 * The `coach-web-env` prelaunch hook (soa#300) — the coach-web analogue of the
 * saga-dash `sync-dash-local-defaults` hook (`dash-defaults.ts`), run right after
 * it in the facade's bring-up sequence, gated on coach-web being launchable.
 *
 * WHY: coach-web (a SvelteKit adapter-static SPA at `<coachRoot>/apps/web/coach-web`)
 * reads its `PUBLIC_*` URLs via `$env/static/public`, which SvelteKit/Vite INLINES
 * from the CHECKED-IN `.env` at vite-dev start. That `.env` carries REMOTE defaults
 * (`https://iam.wootdev.com`, `https://dash.wootdev.com`, …) plus the base coach-api
 * port (wrong at slot > 0). So the browser boots against remote/wrong hosts → the
 * whoami fetch fails → coach-web renders a 503 "Unable to reach the sign-in service"
 * and NO route renders. Injecting env into the process does NOT help — SvelteKit
 * inlines `.env`, not `process.env`.
 *
 * THE FIX: write a per-slot `<coachWebRoot>/.env.local` mapping each PUBLIC_ var to
 * this slot's LOCAL mesh OFFSET url. `.env.local` beats `.env` in Vite/SvelteKit and
 * is gitignored in coach-web, so this overrides the remote defaults without a
 * coach-web code change and without dirtying the checkout. Runs at EVERY slot,
 * including slot 0 — the `.env` remote defaults break local browser-testing at slot 0
 * too (that is the original soa#300).
 *
 * SCOPE: the local `stack` lane only. Under `--tunnel` the coach-web URLs are a
 * separate concern (public tunnel hosts), so the hook NO-OPS and leaves `.env` /
 * any tunnel wiring alone — mirroring how the dash hook keeps tunnel routing distinct.
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
