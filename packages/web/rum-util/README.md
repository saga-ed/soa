# @saga-ed/soa-rum-util

Datadog RUM wrapper with Saga conventions. One package, three intended consumers:
`saga_dash`, `qboard_connectv3`, `janus_login`.

## Why a wrapper

- **One service per app, source-tagged.** `addRumError` / `addRumAction` always set
  `source: <service>` so retention filters like `@error.source:saga_dash` work
  out of the box.
- **Silent no-op when unconfigured.** Pass empty `applicationId` / `clientToken`
  (e.g. local dev with no env vars wired) and the entire module no-ops. Builds
  still ship.
- **Singleton.** Second `initRum` call is ignored, so module-load bootstrap is
  safe across framework re-mounts and HMR.
- **v6 deprecation-free user updates.** `setRumUser` uses `setUserProperty`
  under the hood so incremental patches don't clobber existing fields. `null` in
  the patch removes a field; `undefined` preserves it; a string sets it.

## Quick start

```ts
import {
  initRum,
  setRumUser,
  setRumGlobalContextProperty,
  addRumError,
} from '@saga-ed/soa-rum-util';

initRum({
  service: 'janus_login',
  applicationId: import.meta.env.VITE_DD_RUM_APPLICATION_ID,
  clientToken: import.meta.env.VITE_DD_RUM_CLIENT_TOKEN,
  env: import.meta.env.VITE_DD_ENV ?? 'unknown',
  version: __APP_VERSION__,
  // Unanchored so paths and bare hosts both get tracing headers on the
  // dev (*.wootdev.com) and prod (*.saga.org) backends.
  allowedTracingUrls: [/https:\/\/[^/]+\.wootdev\.com/, /https:\/\/[^/]+\.saga\.org/],
});

setRumUser({ id: session.user_id, name: session.screen_name, org: orgId, role: 'TUTOR' });
setRumGlobalContextProperty('selected_program_ids', programStore.selectedIds);

try {
  // ...
} catch (err) {
  addRumError(err, { surface: 'program-selector' });
}
```

## Integration checklist (new consumer)

Adopting this in a new app (e.g. `qboard_connectv3`, `janus_login`):

1. [Install](#1-install)
2. [Seed SSM](#2-ssm-parameter-convention) in the dev + prod accounts
3. [CI workflow](#3-ci-workflow-github-actions) — fetch SSM into `VITE_DD_*` at build time
4. [Vite config](#4-vite-config) — propagate `VITE_DD_*` and `__APP_VERSION__`
5. [Ambient types](#5-ambient-types) — declare `__APP_VERSION__` and `ImportMetaEnv`
6. [CSP](#6-csp-additions) — allow Datadog intake
7. [Bootstrap](#7-bootstrap-pattern) — `initRum` + wrap bootstrap catches with `addRumError`

Reference implementation: saga-dash —
[`apps/web/dash/src/lib/rum.ts`](https://github.com/saga-ed/saga-dash/blob/main/apps/web/dash/src/lib/rum.ts)
(local wrapper; will swap to this package once it lands on `soa/main`) plus the
surrounding `+layout.ts` / `+layout.svelte` bootstrap.

### 1. Install

```bash
pnpm add @saga-ed/soa-rum-util
# or, inside a workspace that vendors soa:
pnpm add @saga-ed/soa-rum-util@workspace:*
```

### 2. SSM parameter convention

Per-app, per-account, region `us-west-2`:

| Name | Value |
|---|---|
| `/<app>/rum/application-id` | RUM application UUID from Datadog |
| `/<app>/rum/client-token` | RUM client token (NOT a Datadog API key) — masked in CI logs |
| `/<app>/rum/env` | Env tag for Datadog filtering (`dev`, `prod`, ...) |

`<app>` is the short app name (e.g. `dash`, `janus`, `qboard`). Leave **either**
`application-id` or `client-token` empty to disable RUM entirely for that
account — `initRum` returns `false` and every other call no-ops.

Seed once out-of-band (or as a one-shot CFN/Terraform stack) — the values are
account-scoped, not per-branch, so they live longer than any single deploy.

### 3. CI workflow (GitHub Actions)

Copy [`scripts/fetch-rum-config.sh`](scripts/fetch-rum-config.sh) into your repo's
`.github/scripts/` directory (or wherever your workflows look). Call it from
the build job, between AWS credential setup and `pnpm build`:

```yaml
- name: Fetch RUM config from SSM
  env:
    SSM_PREFIX: /janus/rum
    RUM_ENV_DEFAULT: dev   # or 'prod' for the prod-targeting workflow
  run: ./.github/scripts/fetch-rum-config.sh
```

The script:

- Reads `${SSM_PREFIX}/application-id`, `${SSM_PREFIX}/client-token`,
  `${SSM_PREFIX}/env` from SSM.
- Writes them to `$GITHUB_ENV` so the next Build step picks them up via Vite's
  `loadEnv`.
- Uses heredoc-delimited form so a multi-line SSM value can't inject extra
  entries into `$GITHUB_ENV`.
- Tolerates `ParameterNotFound` (falls back to `RUM_ENV_DEFAULT` for the env
  param; empties for app-id / token). Other AWS errors (`AccessDenied`,
  `ThrottlingException`, wrong region) fail the build loudly — an IAM
  regression should not silently ship prod without RUM.
- Masks the client-token in CI logs via `::add-mask::`.

### 4. Vite config

```ts
// apps/<app>/vite.config.ts
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  // envDir relative to vite.config.ts, not the caller's cwd
  const envDir = fileURLToPath(new URL('.', import.meta.url));
  loadEnv(mode, envDir, 'VITE_');
  return {
    define: {
      __APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION ?? 'dev'),
    },
    // ...
  };
});
```

`VITE_DD_*` vars are read inline as `import.meta.env.VITE_DD_*` — no `define`
block needed. `__APP_VERSION__` is a `define` substitution so it tree-shakes
into a string literal at build time.

### 5. Ambient types

Add to your app's `src/app.d.ts` (SvelteKit) or `src/vite-env.d.ts` (vanilla
Vite):

```ts
declare global {
  // eslint-disable-next-line no-var
  const __APP_VERSION__: string;
}

interface ImportMetaEnv {
  readonly VITE_DD_RUM_APPLICATION_ID: string;
  readonly VITE_DD_RUM_CLIENT_TOKEN: string;
  readonly VITE_DD_ENV: string;
  readonly VITE_APP_VERSION: string;
}

export {};
```

### 6. CSP additions

Datadog browser RUM needs:

- `connect-src` — `https://browser-intake-datadoghq.com https://*.browser-intake-datadoghq.com`.
  The wildcard covers regional intakes (`us3`, `us5`, `eu1`, ...) without
  pinning a specific one.
- `worker-src 'self' blob:` — RUM session-replay constructs its worker from a
  blob URL.

Example fragment for a CloudFront `ResponseHeadersPolicy` (SAM):

```yaml
Content-Security-Policy:
  Override: true
  Value: >-
    connect-src 'self'
      https://browser-intake-datadoghq.com
      https://*.browser-intake-datadoghq.com
      https://*.wootdev.com
      https://*.saga.org;
    worker-src 'self' blob:;
    ...
```

If you already have a `connect-src` for backend APIs, append the two Datadog
hosts to it — don't add a second `connect-src` directive (the browser will use
only the most restrictive intersection).

### 7. Bootstrap pattern

Call `initRum` once at module load — the app entry: `main.ts` for vanilla Vite,
`+layout.ts` for SvelteKit.

```ts
// src/routes/+layout.ts (SvelteKit) — or src/main.ts (vanilla Vite)
import { initRum, addRumError } from '@saga-ed/soa-rum-util';

initRum({
  service: 'janus_login',
  applicationId: import.meta.env.VITE_DD_RUM_APPLICATION_ID,
  clientToken: import.meta.env.VITE_DD_RUM_CLIENT_TOKEN,
  env: import.meta.env.VITE_DD_ENV ?? 'unknown',
  version: __APP_VERSION__,
  allowedTracingUrls: [/https:\/\/[^/]+\.wootdev\.com/, /https:\/\/[^/]+\.saga\.org/],
});

// Wrap critical bootstrap paths — the user can't see a try/catch, but Datadog can.
export async function load() {
  try {
    return await bootstrapCriticalData();
  } catch (err) {
    addRumError(err, { surface: 'bootstrap' });
    throw err; // rethrow so the framework still sees the failure
  }
}
```

After login, wire user + global context — typically in an `$effect`
(SvelteKit) or `useEffect` (React) keyed on the session store:

```ts
$effect(() => {
  setRumUserFromSession(sessionStore.current);
  setRumGlobalContextProperty('selected_program_ids', programStore.selectedIds);
});
```

On logout:

```ts
addRumAction('logout');
clearRumUser();
removeRumGlobalContextProperty('selected_program_ids');
```

## Enable / disable

### Production / CI previews

SSM-managed. Set `/<app>/rum/application-id` to an empty string and redeploy —
`initRum` returns `false` and every wrapper call short-circuits. Same path to
re-enable: put the UUID back and redeploy.

No code change is required to toggle, which makes it safe to flip during an
incident if RUM itself starts impacting the page.

### Local dev

RUM is **off by default** locally — no env vars are wired in CI's preview
deploy of your dev branch, and none are seeded in your dev shell. To turn it on
for local debugging:

1. Create `apps/<your-app>/.env.local`:
   ```
   VITE_DD_RUM_APPLICATION_ID=<from datadog console>
   VITE_DD_RUM_CLIENT_TOKEN=<from datadog console>
   VITE_DD_ENV=local
   VITE_APP_VERSION=local
   ```
2. Restart `pnpm dev`.
3. Open browser devtools — check for RUM init logs. Events appear in the
   Datadog RUM Explorer filtered on `@env:local`.

To disable, delete `.env.local` and restart. `.env.local` is in Vite's default
gitignore — verify yours before pushing.

## API

| Function | Purpose |
|---|---|
| `initRum(opts)` | One-shot init. Returns `false` if `applicationId` / `clientToken` empty. |
| `isInitialized()` | Read-only — mostly for tests. |
| `setRumUser(patch)` | Incremental user updates. `null` removes a field, `undefined` preserves, string sets. |
| `removeRumUserProperty(key)` | Explicit one-off remove for a single user field. |
| `clearRumUser()` | On logout. Clears the user object only; remove globals separately. |
| `setRumGlobalContextProperty(k, v)` | Pass-through for app-specific context. |
| `removeRumGlobalContextProperty(k)` | Remove a global context key. Prefer over `set(k, null)` so Datadog doesn't store literal null. |
| `addRumError(err, ctx?)` | Auto-tags `source: <service>` (after spread — caller can't override). |
| `addRumAction(name, ctx?)` | Auto-tags `source: <service>`. |
