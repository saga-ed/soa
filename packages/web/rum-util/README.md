# @saga-ed/soa-rum-util

Datadog RUM wrapper with Saga conventions. One package, three consumers:
`saga_dash`, `qboard_connectv3`, `janus_login`.

## Why a wrapper

- **One service per app, source-tagged.** `addRumError` / `addRumAction` always set
  `source: <service>` so the retention filter pattern from `saga_web`
  (`@error.source:saga_dash`, etc.) works out of the box.
- **Silent no-op when unconfigured.** Pass empty `applicationId` / `clientToken`
  (e.g. local dev with no env vars wired up) and the entire module no-ops.
  Builds still ship.
- **Singleton.** Second `initRum` call is ignored, so `+layout.ts` module-load
  init is safe.
- **v6 deprecation-free user updates.** `setRumUser` uses `setUserProperty`
  under the hood so incremental patches don't clobber existing fields.

## Usage

```ts
// app entry — runs once at module load
import { initRum } from '@saga-ed/soa-rum-util';

initRum({
  service: 'saga_dash',
  applicationId: import.meta.env.VITE_DD_RUM_APPLICATION_ID,
  clientToken: import.meta.env.VITE_DD_RUM_CLIENT_TOKEN,
  env: import.meta.env.VITE_DD_ENV ?? 'unknown',
  version: __APP_VERSION__,
  // Unanchored so paths and bare hosts both get tracing headers on the
  // dev (*.wootdev.com) and prod (*.saga.org) backends.
  allowedTracingUrls: [/https:\/\/[^/]+\.wootdev\.com/, /https:\/\/[^/]+\.saga\.org/],
});

// later, when the user logs in
import { setRumUser, setRumGlobalContextProperty, addRumError } from '@saga-ed/soa-rum-util';

setRumUser({ id: session.user_id, name: session.screen_name, org: orgId, role: 'TUTOR' });
setRumGlobalContextProperty('selected_program_ids', programStore.selectedIds);

// reactive update — null in the patch removes the property
setRumUser({ org: selectedOrgId }); // selectedOrgId: string | null

// custom errors
try {
  // ...
} catch (err) {
  addRumError(err, { surface: 'program-selector' });
}
```

## API

| Function | Purpose |
|---|---|
| `initRum(opts)` | One-shot init. Returns `false` if `applicationId`/`clientToken` empty. |
| `setRumUser(patch)` | Incremental user updates. `null` removes, `undefined` preserves, string sets. |
| `removeRumUserProperty(key)` | Explicit one-off remove for a single user field. |
| `clearRumUser()` | On logout. Clears the user object only; remove globals separately. |
| `setRumGlobalContextProperty(k, v)` | Pass-through for app-specific context. |
| `removeRumGlobalContextProperty(k)` | Remove a global context key. Prefer over `set(k, null)` so Datadog doesn't store literal null. |
| `addRumError(err, ctx?)` | Auto-tags `source: <service>` (after spread — caller can't override). |
| `addRumAction(name, ctx?)` | Auto-tags `source: <service>`. |
| `isInitialized()` | Read-only — mostly for tests. |
