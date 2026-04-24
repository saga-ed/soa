# API reference

JavaScript exports and HTTP endpoints for `@saga-ed/infra-compose`.

## Response contract

All HTTP endpoints and most JS functions return one of:

```javascript
{ ok: true, ... }           // success
{ ok: false, error: "..." } // failure — HTTP 200 (status reflects transport, not outcome)
```

Handlers that throw unexpectedly return HTTP 500 with `{ ok: false, error: <message> }`. Callers should branch on `ok`, not HTTP status.

Profile names must match `/^[a-zA-Z0-9_-]+$/` — the regex is enforced at the handler layer.

## JavaScript API

All imports from `@saga-ed/infra-compose`:

### Lifecycle

```typescript
up(options?: {
    profile?: string;           // default from SEED_PROFILE env, else 'small'
    seed_dir?: string;          // extra seed dir (see adoption-guide)
    data_dir?: string;          // user snapshot dir — default ~/.fixtures/profiles
    compose_file?: string;      // project-specific compose.yml — default bundled master
    services?: string[];        // subset to bring up — default all in compose file
}): Promise<{ status: number; error?: Error }>
```
Starts services via `docker compose up -d`. Writes the profile to `~/.fixtures/active-profile` on success. Returns 0 status on success, non-zero on spawn failure.

```typescript
switch_profile(options?: { profile, compose_file, seed_dir, data_dir }): Promise<...>
```
`down` + `up` with a different `SEED_PROFILE`. Same result type as `up`.

```typescript
reset(options?: { profile, compose_file, seed_dir, data_dir }): Promise<...>
```
`down` + `docker volume rm <svc>-profile-<name>` + `up`. Forces reseed.

```typescript
restore(options?: { profile, compose_file, seed_dir, data_dir }): Promise<...>
```
If volumes for the profile exist, behaves like `reset`. Otherwise, like `up`. Assumes user snapshot files are in `~/.fixtures/profiles/<service>/profile-<name>.{json,sql}`.

### Data

```typescript
snapshot(options: {
    profile: string;
    services?: string[];        // default ['mongo', 'mysql', 'postgres']
    output_dir?: string;        // default ~/.fixtures/profiles
    force?: boolean;            // overwrite existing snapshots
}): Promise<{ status: number; files: string[] }>
```
Connects directly to live DBs and dumps current state. Mongo uses EJSON; MySQL emits SQL; **Postgres is not implemented in JS** (use the CLI `dump` command for pg_dump).

```typescript
list_profiles(options?: { data_dir?, seed_dir? }): { profiles: ProfileInfo[] }
```
Scans built-in seeds (`compose/services/<svc>/seed/profile-*`) and user snapshots (`~/.fixtures/profiles/<svc>/profile-*`). Returns:

```typescript
type ProfileInfo = {
    name: string;              // 'small', 'my-snap', etc.
    service: 'mongo' | 'mysql' | 'postgres';
    type: 'seed' | 'snapshot'; // detected from _meta marker (JSON) or header comment (SQL)
    path: string;
};
```

```typescript
delete_profile_data(options: { profile: string, data_dir?: string }): { deleted: number, profile: string }
```
Removes user snapshot files matching `profile-<name>.*` across `mongo/`, `mysql/`, `postgres/` subdirs. Built-in seeds are never touched. Profile name is validated against the regex.

### State

```typescript
get_active_profile(): { profile: string, switched_at: string } | { profile: string, switched_at: null } | null
```
Reads `~/.fixtures/active-profile`. Returns null if file missing or empty. Parses JSON format; legacy plain-text (single-line profile name) returns `{ profile, switched_at: null }`.

## HTTP API — `create_router(options)`

```typescript
import { create_router } from '@saga-ed/infra-compose/router';

app.use('/infra', create_router({
    compose_file?: string;                    // threaded into every handler input
    on_after_switch?: () => Promise<void>;    // runs after successful /switch
    on_after_reset?: () => Promise<void>;     // runs after successful /reset
    on_after_snapshot?: () => Promise<void>;  // runs after successful /snapshot
}));
```

### Endpoints

| Method | Path | Body / Query | Response |
|---|---|---|---|
| `POST` | `/switch` | `{profile}` | `{ok, profile, status}` |
| `POST` | `/reset` | `{profile}` | `{ok, profile, status}` |
| `POST` | `/restore` | `{profile}` | `{ok, profile, status}` |
| `POST` | `/snapshot` | `{profile, services?, force?}` | `{ok, profile, files}` |
| `POST` | `/delete-profile` | `{profile}` | `{ok, deleted, profile}` |
| `GET` | `/profiles` | — | `{ok, profiles, active}` |
| `GET` | `/active-profile` | — | `{ok, active}` |
| `GET` | `/health` | — | `{ok, service: "infra-compose", active}` |

All POST endpoints parse `Content-Type: application/json`. The `compose_file` option from `create_router` is transparently merged into every handler's input, so callers don't need to pass it on each request.

### Lifecycle hooks

Hooks fire **after** a successful operation (handler returned `{ok: true}`), never on failure. They receive the handler's result as their only argument:

```typescript
create_router({
    on_after_switch: async (result) => {
        console.log('switched to', result.profile);
        await reconnect_app_db();
    },
});
```

fixture-serve uses this to:
1. Reconnect MongoDB (so its controllers see the new profile's data)
2. Restart the application via `systemctl restart <service>-*`

## CLI

Run with `npx infra-compose <command>` from anywhere, or `./bin/infra-compose` from the package root.

```
Lifecycle:
  up [--profile NAME] [--seed-dir DIR]
  switch --profile NAME [--seed-dir DIR]
  down
  reset --profile NAME [--seed-dir DIR]

Data:
  dump --profile NAME [--services LIST] [--output-dir DIR] [--force]
  restore --profile NAME

Utility:
  check-ports
  status
  shell <mongo|mysql|postgres|redis>
  list-profiles
  volumes
  completion           # bash completion, eval "$(infra-compose completion)"
```

All commands accept `-- EXTRA_ARGS...` which are passed through to `docker compose`. Example:

```bash
npx infra-compose up --profile small -- -f ./my-overlay.yml
```

This runs `docker compose -f $PKG_ROOT/compose/compose.yml -f ./my-overlay.yml up -d` via the `include:` + overlay pattern.

## Handler exports (for custom routers)

If you're building a custom HTTP layer and want the validated wrappers without the Express router, import from `@saga-ed/infra-compose/handlers`:

```typescript
import {
    handle_snapshot, handle_switch, handle_reset, handle_restore,
    handle_list_profiles, handle_delete_profile, handle_get_active,
} from '@saga-ed/infra-compose/handlers';

// Each handler takes a single plain object { profile, compose_file?, ... }
// and returns { ok, ... } the same as the HTTP response body.
const result = await handle_switch({ profile: 'basic', compose_file: '/etc/a.yml' });
```

## EC2 db-host subsystem

For the snapper VM pattern (dynamic DB provisioning on a shared EC2 host), see `src/ec2/server.js` and `src/ec2/ec2-router.js`. Exported as:

```typescript
import { create_ec2_router } from '@saga-ed/infra-compose/ec2-router';
// import server directly as a bin
import '@saga-ed/infra-compose/ec2-server';
```

The EC2 subsystem has its own lifecycle (create/start/stop/reset/delete DB instances with dynamic port allocation and Cloud Map service discovery) and is not currently covered by unit tests — it's operated manually on the VM.
