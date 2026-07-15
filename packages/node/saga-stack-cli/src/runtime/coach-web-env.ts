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
 * SCOPE: BOTH lanes (soa#298). `.env.local` is the only mechanism that reaches a
 * SvelteKit `PUBLIC_*` var, so it owns coach-web's URLs in the tunnel lane too —
 * it just writes the PUBLIC tunnel hosts instead of the local mesh.
 *
 * WHY the tunnel lane needs this at all: `tunnelOverlay()` (core/launch-plan.ts)
 * sets `PUBLIC_COACH_API_URL` in coach-web's LAUNCH ENV, but that is the exact
 * thing SvelteKit ignores — same trap as soa#300 above — so the overlay's value
 * never reaches the browser. Two further gaps it cannot close:
 *   - `PUBLIC_IAM_API_URL` is NOT set by the overlay (it assumed iam sits behind
 *     coach-api server-side), yet coach-web's browser fetches whoami DIRECT from
 *     iam (`api/session.ts`: `${PUBLIC_IAM_API_URL}/trpc/auth.whoami`), so a remote
 *     browser would dial the `.env` default `https://iam.wootdev.com` and 503;
 *   - a `.env.local` left by an earlier LOCAL run would SHADOW the tunnel values
 *     anyway (`.env.local` > `.env` > launch env), so no-oping here was not inert.
 * Writing the tunnel hosts here fixes all three at once and keeps ONE mechanism.
 * The overlay's `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` / coach-api CORS vars are
 * read from the process env by vite/express and are unaffected — they still apply.
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
   * True iff running in `--tunnel` mode ⇒ write the PUBLIC tunnel hosts rather than
   * the local mesh (soa#298). Requires `tunnelDomain`.
   * Default false (the native partial-stack default).
   */
  tunnel?: boolean;
  /**
   * `<moniker>.<VMS_BASE>` — the tunnel domain, required when `tunnel` is true (the
   * facade always passes it together with `tunnel`). If `tunnel` is set WITHOUT a
   * domain we cannot name the public hosts, so the hook removes any stale `.env.local`
   * rather than writing localhost URLs a remote browser could never reach.
   */
  tunnelDomain?: string;
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
  action: 'wrote' | 'wrote-tunnel' | 'noop-tunnel' | 'noop-no-app';
  /** The `.env.local` path acted on (when applicable). */
  path?: string;
}

/**
 * The vendored `tunnel.sh` SERVICES label for each service coach-web's browser dials
 * (soa#298). Labels are NOT derivable from the ServiceId (`saga-dash`→`dash`, while
 * `coach-api` keeps its suffix), so they are explicit — and pinned against the real
 * `vendor/tunnel.sh` SERVICES table by the drift guard in
 * `src/__tests__/tunnel-service-labels.unit.test.ts`, so a re-vendored script that
 * renames a host fails the build instead of 502-ing a remote browser.
 *
 * Deliberately separate from `TUNNEL_SERVICE_LABELS` (e2e-orchestrate): that table
 * serves `PLAYWRIGHT_*_URL` for the e2e lane and carries no coach entries. Both are
 * guarded against the same vendored source of truth.
 */
export const COACH_WEB_TUNNEL_LABELS: Readonly<Partial<Record<ServiceId, string>>> = Object.freeze({
  'iam-api': 'iam',
  'coach-api': 'coach-api',
  'saga-dash': 'dash',
});

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
 * Build the `.env.local` contents. Each coach-web `PUBLIC_*` url resolves to either
 * this slot's LOCAL mesh offset host, or — when `tunnelDomain` is given — the PUBLIC
 * tunnel host for that service. Trailing newline.
 *
 *   PUBLIC_IAM_API_URL   ← iam-api    (browser dials iam DIRECT for whoami)
 *   PUBLIC_COACH_API_URL ← coach-api  (the coach BFF)
 *   PUBLIC_DASHBOARD_URL ← saga-dash  (the "open dashboard" link)
 *   PUBLIC_LOGIN_URL     ← iam-api    (the whoami 401 challenge login lives at iam's /demo;
 *                                      there is no `login` host in tunnel.sh SERVICES,
 *                                      so it points at iam in BOTH lanes)
 *
 * LOCAL lane: a PUBLIC_ line whose backing service has no resolved port is omitted
 * rather than emitting `localhost:undefined` (coach-web falls back to its `.env`
 * default for that one var — never a broken URL).
 *
 * TUNNEL lane: every host is a static `tunnel.sh` label, so all four are always
 * written — there is no port to be missing, and falling back to a `.env` REMOTE
 * default is exactly the 503 this exists to prevent.
 *
 * PUBLIC_EMBED_ALLOWED_ORIGINS is deliberately LEFT ALONE — not needed for boot.
 */
export function coachWebEnvLocalContents(
  stackPorts: Partial<Record<ServiceId, number>>,
  tunnelDomain?: string,
): string {
  /** This service's browser-reachable base URL for the active lane, if resolvable. */
  const urlFor = (svc: ServiceId): string | undefined => {
    if (tunnelDomain !== undefined) {
      const label = COACH_WEB_TUNNEL_LABELS[svc];
      /* c8 ignore next — every svc below is in the frozen label table. */
      return label === undefined ? undefined : `https://${label}.${tunnelDomain}`;
    }
    const port = stackPorts[svc];
    return port === undefined ? undefined : `http://localhost:${port}`;
  };

  const iam = urlFor('iam-api');
  const coachApi = urlFor('coach-api');
  const dash = urlFor('saga-dash');

  const header =
    tunnelDomain !== undefined
      ? [
          '# Generated by `ss --tunnel` at coach-web launch (soa#298) — GITIGNORED, do not commit.',
          '# Points coach-web\'s browser at the PUBLIC tunnel hosts: SvelteKit inlines these',
          '# PUBLIC_* vars from `.env.local` at vite-dev start and IGNORES the launch env,',
          '# so this file — not tunnelOverlay() — is what a remote browser actually sees.',
        ]
      : [
          '# Generated per-slot by `ss` at coach-web launch (soa#300) — GITIGNORED, do not commit.',
          '# Overrides the checked-in `.env` REMOTE defaults so coach-web\'s browser boots',
          '# against the LOCAL ss mesh: SvelteKit inlines these PUBLIC_* vars at vite-dev',
          '# start, and `.env.local` wins over `.env`.',
        ];

  const vars: string[] = [];
  if (iam !== undefined) vars.push(`PUBLIC_IAM_API_URL=${iam}`);
  if (coachApi !== undefined) vars.push(`PUBLIC_COACH_API_URL=${coachApi}`);
  if (dash !== undefined) vars.push(`PUBLIC_DASHBOARD_URL=${dash}`);
  if (iam !== undefined) vars.push(`PUBLIC_LOGIN_URL=${iam}`);

  return `${[...header, ...vars].join('\n')}\n`;
}

/**
 * Run the prelaunch hook. Pure-decision over the injectable `CoachWebFs`, so it's
 * fully testable; returns what it did.
 *   - No coach-web app dir at the resolved path ⇒ no-op.
 *   - Tunnel mode WITH a domain ⇒ WRITE `.env.local` with the PUBLIC tunnel hosts.
 *   - Tunnel mode WITHOUT a domain (not reachable via the facade, which always pairs
 *     them) ⇒ REMOVE any stale `.env.local`. We cannot name the public hosts, and a
 *     leftover LOCAL file would shadow `.env` and point a remote browser at localhost;
 *     removing degrades to coach-web's own `.env` defaults instead of a wrong host.
 *   - Otherwise (local lane) ⇒ WRITE `.env.local` with the slot's offset localhost URLs.
 */
export function syncCoachWebEnvLocal(
  ctx: CoachWebEnvContext,
  fs: CoachWebFs = makeRealCoachWebFs(),
): CoachWebSyncResult {
  // coach-web not checked out at the resolved path ⇒ nothing to write (checked FIRST:
  // with no app dir there is no `.env.local` to write OR remove, in either lane).
  if (!fs.existsDir(ctx.coachWebRoot)) return { action: 'noop-no-app' };

  const path = coachWebEnvLocalPath(ctx.coachWebRoot);

  if (ctx.tunnel && ctx.tunnelDomain === undefined) {
    fs.remove(path);
    return { action: 'noop-tunnel', path };
  }

  const tunnelDomain = ctx.tunnel ? ctx.tunnelDomain : undefined;
  fs.write(path, coachWebEnvLocalContents(ctx.stackPorts, tunnelDomain));
  return { action: tunnelDomain !== undefined ? 'wrote-tunnel' : 'wrote', path };
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
