# `ss env` — deployed shared environments (dev / training)

_soa#355. Phase 0: list, discover, tunnel, and inspect (read-only).
Phase 1: `env org reset` — the surgical fixture-org delete (below)._

Where every other `ss` topic drives the **local** synthetic stack, `env`
targets the **deployed shared** compositions — `dev` (`*.wootdev.com`, the
fleet CI deploys to on merge to main) and `training` (`*.saga-training.org`,
the persistent staff-training tenant). Both live in the dev AWS account.
Access is data-plane: SSM port-forwarding straight to the underlying stores —
no janus cookie, no API layer.

## Prerequisites

- An authenticated AWS session **in the dev account** (`396913734878`):
  `aws sso login --profile dev_admin`, then pass `--profile dev_admin` (or set
  `AWS_PROFILE`). Both `dev` and `training` live in the dev account; `list`,
  `discover`, and `connect` run an account preflight and refuse with a
  switch-profile hint if your credentials resolve elsewhere (e.g. the prod
  account) — no more cryptic `ResourceNotFoundException`.
- **Tier:** SSM port-forwarding needs `app-infra` (`SagaCap-SSMPortForward`)
  or `app-deploy`. The observer tier cannot open sessions and cannot read the
  control-plane ledger (an AccessDenied from `env list` means *wrong tier*,
  not a missing environment). `/discover-aws-access` reconciles your profiles.
- `aws` and `psql` binaries on PATH (the CLI shells out; it carries no AWS SDK
  or DB driver).

## Commands

```bash
ss env list                              # environments + control-plane ledger footprint
ss env discover --env dev                # SSM params (data-store wiring) + the SSM jump host
ss env connect iam --env dev             # SSM tunnel to shared Postgres; prints DATABASE_URL; Ctrl-C closes
ss env connect programs --local-port 15433 --print-only   # resolve only, no tunnel
ss env verify --env dev                  # health-gate every deployed service (non-zero if a required one is down)
ss env org status --org emptyOrg \
  --url iam=postgres://…:15432/iam \
  --url programs=postgres://…:15433/programs              # the org's cross-store footprint
```

## `env verify` — the deployed-env health gate

The `stack verify` analogue for dev/training. It probes every deployed service
and **judges health by the response BODY, not the status code** — that is not
stylistic:

> `*.wootdev.com` and `*.saga-training.org` are wildcard DNS onto the shared
> ALB, whose default action answers **HTTP 200 with the body `dev-account-alb`**
> for *any* unmatched hostname. A status-code-only gate therefore reports
> services that do not exist as healthy. Verified live 2026-07-21.

So a healthy API must answer JSON with a `service` and a healthy `status` — the
live fleet uses three different words (`ok`: iam/programs/scheduling/sessions/
content · `running`: sis/ads-adm · `healthy`: coach), all allowlisted; a
`degraded`/`down` status still fails. Frontends must answer an HTML document.

Deployed hostnames are **not** the manifest `tunnelSlug` — the map is explicit
and body-verified (`core/env/services.ts`): `iam`/`sis` are short, the rest are
the full service id (`programs-api`, `sessions-api`, …), and `coach.<domain>` is
the coach **web** app (the API is `coach-api`). `connect-api`, `connect-web`, and
`rtsm-api` have **no public route** on either env — they are reported as
"not HTTP-verifiable" (optional, so they don't fail the gate) rather than
silently green; an ECS platform check is the follow-up that covers them.

```bash
ss env verify --env dev                          # 10/13 healthy, 3 unroutable
ss env verify --env training --tolerate sis-api  # accept a known-down service
ss env verify --env dev --org emptyOrg --url iam=postgres://…:15432/iam
```

`--org` additionally asserts the fixture org's **seed skeleton** (org row +
admin + admin membership) over the iam connection — i.e. "is this org usable?"
as opposed to "are the services up?". A broken skeleton fails the gate.

`env connect` resolves the DB target **from the service's own live ECS task
definition** (`<ecsService>-<identifier>` across the shared clusters): either
its `DATABASE_URL` secret (iam, program-hub, coach) or its split `POSTGRES_*`
env + password secret (ads-adm). That makes it self-maintaining — the same
store on `training` differs only by name suffix. Routing (live-verified
2026-07-21): `.dbs-v2.local` targets tunnel **via the container's own db-host
instance with a 127.0.0.1 dial** (CloudMap `discover-instances` → host + port;
the shared jump host's SG cannot reach the containers — a dial from it hangs);
anything else (shared RDS) goes via the shared jump host. Resolution is
transparent (every candidate printed) and overridable: `--host`,
`--remote-port`, `--username`, `--database`. The tunnel holds in the
foreground — it dies with the command, never orphaned. Postgres-first; Mongo
(needs `directConnection=true` through SSM tunnels) is a follow-up. If `psql`
is not installed, queries fall back to `docker run --network host
postgres:18-alpine psql` automatically.

## Org targeting is slug-only (the Jenny guard)

`env org …` commands accept **catalog slugs** (`--org emptyOrg`), never raw
UUIDs — the UUID is *derived* via the fleet's uuidv5 seed-id scheme
(byte-verified against `@saga-ed/iam-seed-ids` in unit tests). Anything not in
the resettable catalog — every hand-built org, e.g. the training orgs used for
real staff sessions — is structurally untargetable. Growing the catalog is a
reviewed code change (`src/core/env/seed-ids.ts`), not a runtime input.

## `env org status`

The debug primitive and the dry-run half of the future reset. It resolves the
org's id-sets — org id + admin offline from the catalog; group / member-user /
program ids **live** from the two anchor stores when `--url iam=…` and
`--url programs=…` are given (else `partial-offline`, and each table says so)
— then counts org-linked rows per store/table. Rows marked `[projection]` are
event-materialized mirrors (the orphan category: projections never self-heal;
a future reset must sweep them by the same id-sets, and a planned `--orphans`
mode will diff them against source).

The footprint map (`src/core/env/footprint.ts`) is the anchor + first ring,
verified against each repo's prisma schema, and deliberately extensible —
stores/tables not yet mapped are visible as absent, never silently skipped.

## `env org reset` (Phase 1 — destructive)

Surgically deletes ONE fixture org's data across the connected stores, back
to the seeded skeleton. Follows `stack wipe`'s destructive canon: `--dry-run`
enumerates per-table DELETE counts (projections marked) and exits 0 touching
nothing; a plain run shows the same enumeration and prompts once; `--yes`
skips the prompt; a declined prompt aborts with exit 0.

```bash
ss env org reset --org emptyOrg \
  --url iam=postgres://…15432/rostering-iam-canonical \
  --url programs=postgres://…15433/programs \
  --url scheduling=… --url sessions=… --url ads-adm=… --url coach=… --url iam-pii=… \
  --dry-run                        # counts only, nothing changes
ss env org reset --org emptyOrg --url iam=… --url programs=… --snapshot --yes
```

### Guards (structural, not flag-skippable)

1. **Slug-only targeting** — the same catalog guard as `org status`.
2. **Both anchors mandatory** — `--url iam=…` AND `--url programs=…` or the
   command refuses (dry-run included): id-sets resolve live or not at all.
   Other stores without a `--url` are **skipped with loud warnings** — their
   org rows survive, and orphan-union resolution sourced there is incomplete.
3. **Pre-flight identity assertion** — the org group row must exist with the
   catalog display name AND the admin user must exist with the catalog email,
   or the run refuses: proof the connected DB really holds the seeded org.

### Skeleton semantics

The seeded skeleton **survives by explicit SQL predicates** on deterministic
catalog ids (never by command logic): the org `groups` row, the admin user,
the admin's seeded membership, the org's seeded personas (and their cascaded
permissions), and the org row's seeded `group_attributes`/`group_auth_config`.
Multi-org users are never deleted — a user with ANY membership outside the
org's groups (any status) survives — and neither are **env-wide actors**: iam
grants environment-level identity without membership rows (`users.role` other
than `USER`, `user_system_roles`), so users carrying either marker survive
even when their only membership is inside the org. Every cross-store user
sweep (projection mirrors, `user_pii`, coach progress) keys on the
survivors-excluded `userDelIds` set — which carries the same exclusions — so
their mirrors survive with them.
Deletes run **one BEGIN/COMMIT transaction per store** (single `psql -c`,
`ON_ERROR_STOP` — all-or-nothing per store), leaf stores first, iam last, then
a post-verify recount reports before/after per table (leftovers flagged loud;
tables whose delete predicate subqueries rows deleted in the same transaction
— `DayTypeBlock`, `ProgramSectionMapping` — are reported `verify: indirect`
instead of a self-blinded 0, and `users` recounts by the pre-resolved
`userDelIds` literal set) and a skeleton check (org row + admin + membership)
— a broken skeleton exits non-zero after the full report.

### `--snapshot` (best-effort restore points)

Takes a per-store dump via the db-host-v2 orchestrator Lambda
(`dev-db-host-orchestrator`, profile `pre-org-reset`, versioned + immutable in
`s3://saga-db-seeds-dev/<serviceName>/`) BEFORE deleting. **Dev only**: the
orchestrator is dev's control plane, so `--snapshot` with any other `--env`
is refused up front (a "successful" snapshot of the wrong environment's
databases would be worse than none). Best-effort by
design (dev-only data, regenerable seed): an unreachable orchestrator or a
failed dump warns and proceeds — but a **"not in registry"** response means
the target name is wrong and aborts the whole reset. Registry names are known
for `iam` (`rostering-iam-canonical`) and `ads-adm` (`ads-adm-postgres`);
supply others with `--snapshot-service <store>=<serviceName>`. Undo a botched
reset with the orchestrator's `switch`/`restore` against that profile.

### Explicit non-goals

- **No cross-store atomicity** — one transaction per store; a mid-run failure
  leaves later stores untouched (iam last keeps the resolution evidence for a
  re-run).
- **Never touched anywhere**: `outbox_event`, `consumed_events`,
  `snapshot_metadata`, `audit_logs` (DB-rule append-only), sessions'
  `projection_readiness` + `authz_persona_definition`, coach's authored
  content + `persona_definition`, programs' `content_item`, and the whole
  content-api database (no org-reachable column exists).
- **Known residue**: `session_alias` rows minted before their lazily-written
  session row (unreachable via sessionIds), and journey-test-added attributes
  on the org row itself (kept with the seeded ones).
- No claim record yet (env-level claims are a follow-up), and no Mongo stores.

## Safety posture

Phase 0 is read-only: ledger queries, SSM parameter reads, a port-forward,
and `SELECT count(*)`. All id inlining is gated (`assertUuids`; session ids
are base64url natural keys with their own strict-charset gate) so no
untrusted string ever reaches SQL.

See `~/dev/shared-env-reset-research.md` (research) and soa#355 (the epic).
