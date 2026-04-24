# Troubleshooting

Common issues encountered when adopting or operating infra-compose.

## Port conflicts

**Symptom**: `Error: bind: address already in use` when running `make up` or `npx infra-compose up`.

**Diagnosis**: Another container or process is bound to one of infra-compose's offset ports (27018, 3307, 5433, 6380, 5673, 15673).

```bash
# From the Makefile path:
make check-ports

# Or use the CLI directly — prints both the conflicting container and the stop command:
npx infra-compose check-ports
```

**Fix**: stop the conflicting container (`docker stop <name>` or `docker compose -p <project> down`), or override the port:

```bash
# Project-local override (gitignored)
echo "MONGO_PORT=27020" >> .env

# Or user-level override (survives npm install -g)
echo "MONGO_PORT=27020" >> ~/.fixtures/.env
```

## Init containers never become healthy

**Symptom**: `make up` hangs; `docker ps` shows the `*_init` container restarting.

**Diagnosis**: The init container is failing its seed step. Check its logs:

```bash
docker logs soa-mongo_init-1
docker logs soa-mysql_init-1
docker logs soa-postgres_init-1
```

Common causes:
- **Corrupt seed file** in `compose/services/<svc>/seed/profile-<name>.{json,sql}` — check the profile syntax
- **Volume contains partial seed from a crashed previous run** — `docker volume rm <svc>-profile-<name>` then retry
- **Custom `--seed-dir` points at malformed data** — validate the overlay files

## VPN / Docker daemon IP range collisions

**Symptom**: Containers can start but can't reach each other, or network packets between containers disappear. Often seen when connected to a corporate VPN.

**Diagnosis**: Docker's default bridge network uses 172.17.0.0/16 and dynamically allocates from 172.18+. Corporate VPN routes commonly overlap these ranges. Check your VPN client for its configured routes.

**Fix**: configure Docker to use a different network range via `/etc/docker/daemon.json`:

```json
{
  "default-address-pools": [
    { "base": "10.200.0.0/16", "size": 24 }
  ]
}
```

Restart Docker Desktop / the Docker daemon after editing. On Linux: `sudo systemctl restart docker`.

## Env file precedence is confusing

**Symptom**: Your `MONGO_PORT=27020` override isn't being picked up, or it *was* being picked up and now isn't after `npm install -g @saga-ed/infra-compose`.

**Diagnosis**: There are three env files loaded in order (later wins):

1. `$PKG_ROOT/.env.defaults` — bundled with the package, **wiped by `npm install -g`**
2. `$PKG_ROOT/.env` — project-local, gitignored
3. `~/.fixtures/.env` — user-level, **persists across reinstalls**

**Fix**: put personal overrides that should survive upgrades in `~/.fixtures/.env`, not `$PKG_ROOT/.env`.

```bash
mkdir -p ~/.fixtures
cat >> ~/.fixtures/.env <<EOF
MONGO_PORT=27020
MYSQL_PORT=3309
EOF
```

## `get_active_profile()` returns null unexpectedly

**Symptom**: `GET /infra/active-profile` returns `{ok: true, active: null}` even though containers are running.

**Diagnosis**: `~/.fixtures/active-profile` is only written by `up`, `switch_profile`, `reset`, and `restore`. If containers were started via raw `docker compose up` (bypassing the API layer), the state file isn't updated.

**Fix**: always go through the CLI or API, not raw `docker compose`. If you must bypass, write the file manually:

```bash
mkdir -p ~/.fixtures
echo '{"profile":"basic","switched_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > ~/.fixtures/active-profile
```

## Postgres snapshot is missing from `snapshot()` output

**Symptom**: After calling `snapshot({profile: 'X', services: ['mongo', 'mysql', 'postgres']})`, no `profile-X.sql` file appears under `~/.fixtures/profiles/postgres/`.

**Diagnosis**: `snapshot()` in `api.js` does not implement Postgres dump. Mongo uses the mongodb driver + EJSON; MySQL uses mysql2 + hand-crafted SQL. Postgres would require `pg` or shelling to `pg_dump` — not yet wired in.

**Fix**: use the CLI `dump` command for Postgres — it shells to `pg_dump` correctly:

```bash
npx infra-compose dump --profile X --services postgres
```

Or run `pg_dump` yourself and write the output to `~/.fixtures/profiles/postgres/profile-X.sql` with an appropriate `-- @infra-compose/snapshot` header comment.

## `include:` path in consumer repos stopped working after 1.0.0

**Symptom**: `docker compose: Error: path not found: node_modules/@saga-ed/infra-compose/services/mongo/compose.yml`

**Diagnosis**: In 1.0.0, `services/` moved under `compose/`. External consumers who installed the package via npm see the new layout.

**Fix**: update include paths:

```diff
 include:
-  - path: node_modules/@saga-ed/infra-compose/services/mongo/compose.yml
+  - path: node_modules/@saga-ed/infra-compose/compose/services/mongo/compose.yml
```

See the [CHANGELOG](../CHANGELOG.md) or commit `refactor!: restructure …` for the full move map.

## `docker compose up` works but fixture-serve's `/infra/switch` fails

**Symptom**: CLI operations succeed, but HTTP-driven profile changes return `{ok: false, error: "...compose.yml: no such file..."}`.

**Diagnosis**: The HTTP router isn't passing `compose_file` to handlers. This commonly happens when:
- You're on a pre-0.10.16 infra-compose where the router didn't thread `compose_file`
- You forgot to pass `compose_file` to `create_router({compose_file})` in your fixture-serve wiring

**Fix**: upgrade to ≥1.0.0 (includes fix from commit 5533bcb) and pass the compose file explicitly:

```javascript
app.use('/infra', create_router({
    compose_file: '/opt/my-service/compose.yml',  // <-- don't forget this
    on_after_switch: reconnect_and_restart,
}));
```

## Tests fail with `MongoMemoryServer` download errors

**Symptom**: fixture-serve's `fixture-controller.int.test.ts` fails on CI with `MongoError: unable to download mongod`.

**Diagnosis**: `mongodb-memory-server` downloads mongod binaries on first use. On a fresh CI runner without internet or with a restrictive firewall, the download fails.

**Fix**: either pre-pull the binary in CI setup (`npx mongodb-memory-server get-port` warms the cache), or set `MONGOMS_SYSTEM_BINARY=/usr/bin/mongod` to reuse a system mongod.

## Leftover test-seed profile files

**Symptom**: `compose/services/mongo/seed/profile-test-seed-*.json` files accumulate after running the integration suite.

**Diagnosis**: `test/integration/run-integration.sh` creates seed files with unique names (`test-seed-<PID>`) for isolation. Cleanup is best-effort — if the suite aborts mid-run, files remain.

**Fix**: delete manually after a crashed run:

```bash
rm -f compose/services/{mongo,mysql,postgres}/seed/profile-test-seed-*.{json,sql}
rm -f compose/services/{mongo,mysql,postgres}/seed/profile-test-dump-*.{json,sql}
```

Or clean all leftovers before a fresh run by adding a pre-step to your CI or local workflow.
