# `ss env` — shared-env org debug + reset: manual test plan

_soa#355 · PR soa#356 · 2026-07-21. Companion to `~/dev/shared-env-reset-research.md`._

**Goal under test:** start from the Empty Org on **dev** (`dash.wootdev.com`), inspect its
data footprint, and reset it back to the seeded skeleton — repeatably, without touching any
other org (especially the hand-built training orgs Jenny uses). Dev is the first target;
`training` and other deployed sandboxes are design targets (env is a flag, never a hardcode).

---

## 0. Prerequisites

- **AWS session**: `aws sso login --profile dev_admin` (dev account `396913734878`).
- **Tier**: SSM port-forwarding needs **app-infra** (`SagaCap-SSMPortForward`) or **app-deploy**.
  Observer/app-runtime cannot open sessions *or* read the control-plane ledger — an AccessDenied
  from `env list` means *wrong tier*, not a missing env. Run `/discover-aws-access` to reconcile.
- **Binaries**: `aws` and `session-manager-plugin` on PATH. `psql` optional — the CLI falls back
  to `docker run --network host postgres:18-alpine psql` automatically.
- **CLI build** (branch not yet released):
  ```bash
  cd ~/dev/soa-worktrees/gh340-wipe/packages/node/saga-stack-cli && npm run build
  CLI="$PWD/bin/run.js"          # use `node $CLI env …` below; `ss` still points at released main
  ```

---

## 1. Full command surface added

All under the `env` topic. Read-only unless noted **[DESTRUCTIVE]**.

| Command | Purpose | Key flags |
|---|---|---|
| `env list` | Deployed envs (dev, training) + dev-platform ledger footprint | `--profile`, `--output-json` |
| `env discover` | Walk an env's SSM param roots (data-store wiring) + resolve the Online SSM jump host | `--env`, `--profile`, `--filter <regex>` |
| `env connect <store>` | Open an SSM tunnel to a store's Postgres; print a ready `DATABASE_URL`; holds until Ctrl-C | `--env`, `--profile`, `--local-port`, `--host`, `--remote-port`, `--username`, `--database`, `--print-only` |
| `env verify` | Health-gate every deployed service (judged by **response body**, not status code) + optional ECS platform check; non-zero exit if a required service is down | `--env`, `--tolerate <ids>`, `--ecs`, `--profile`, `--org <slug>` (+ `--url iam=…`) |
| `env org status --org <slug>` | One fixture org's cross-store footprint (per-table counts; projections marked) | `--url <store>=<conn>` (repeatable), `--offline` |
| `env org reset --org <slug>` **[DESTRUCTIVE]** | Surgically delete the org's data back to the seeded skeleton | `--url <store>=<conn>` (repeatable), `--dry-run`, `--yes`, `--snapshot`, `--snapshot-service <store>=<name>`, `--env`, `--profile` |

**Store keys** (`--url` / `connect <store>`): `iam`, `programs`, `scheduling`, `sessions`,
`ads-adm`, `coach` (all connectable). `iam-pii` is a reset store key but **not yet connectable**
via `env connect` (known gap — see §6).

**Targeting safety (the Jenny guard):** `env org …` accepts catalog **slugs** only (`--org emptyOrg`);
the UUID is derived (uuidv5 seed-id scheme). Raw UUIDs and unknown slugs are refused, so every
hand-built org (training) is structurally untargetable. Catalog today: `emptyOrg` only.

**Live-verified store routing** (dev, 2026-07-21 — each store is a db-host-v2 container reached via
CloudMap → the container's own EC2 instance with a 127.0.0.1 dial; the shared jump host's SG cannot
reach the containers):

| store | CloudMap service | remote port | suggested local port |
|---|---|---|---|
| iam | `rostering-iam-canonical` | 5440 | 15432 |
| programs | `program-hub-programs-canonical` | 5432 | 15433 |
| scheduling | `program-hub-scheduling-canonical` | 5433 | 15434 |
| sessions | `program-hub-sessions-postgres` | 5436 | 15435 |
| ads-adm | `ads-adm-postgres` | 5471 | 15436 |
| coach | `coach-api-runtime` | 5445 | 15437 |

---

## 1b. `env verify` — what it actually checks (read this before T2b)

Two traps make this command non-obvious; both were found live and are the reason
it exists in this shape:

- **HTTP 200 is NOT a health signal here.** `*.wootdev.com` / `*.saga-training.org`
  are wildcard DNS onto the shared ALB, whose default action answers **200 with the
  body `dev-account-alb`** for *any* unmatched hostname. A status-code-only check
  reports services that don't exist as healthy. Verify judges the **body**: APIs must
  answer JSON with a `service` and an allowlisted `status` — the fleet uses three
  different words (`ok`: iam/programs/scheduling/sessions/content · `running`:
  sis/ads-adm · `healthy`: coach); `degraded`/`down` fail. Frontends must answer HTML.
- **Deployed hostnames are not the manifest slug.** `iam`/`sis` are short; the rest are
  the full service id (`programs-api`, `sessions-api`, …); `coach.<domain>` is the coach
  **web app** (the API is `coach-api`).

Coverage today: **dev 16/16, training 15/16**. The map is taken from the ALB host-header
rules, Route53, and each owning repo's deploy docs — never guessed:

| service | host | source |
|---|---|---|
| connect-api | `connectv3-api.<domain>` `/connectv3/v1/health` | qboard/CLAUDE.md:112 |
| rtsm-api | `chi-1.rtsm.<domain>` `/health` | rtsm/README.md + Jeff (canonical route) |
| fleek | `chi-1.fleek.<domain>` `/health` (Caddy, 200/empty) | fleek/OPS.md:92,145 |
| fleek-recorder | `recorder-chi-1.fleek.wootdev.com` `/v1/health` | fleek/OPS.md:93 (livekit half) |
| connect-web | `<branch>.d2ezd4i8b4uexc.amplifyapp.com` (`dev` / `training`) | qboard/CLAUDE.md "Web main" — Amplify app `connectv3`, **no custom domain** |

`rtsm`/`fleek` run on their **own non-AWS clusters** (`*.rtsm.` / `*.fleek.` — geo nodes
chi-1/nyc-1/phx-1/…), which is why they are absent from ECS and the ALBs. They are **SHARED
between dev and training** — one fleet pinned to `*.wootdev.com`, never domain-templated per
env. Evidence: the **training** `qboard-connectv3-api-training` task definition sets
`RECORDER_URL_TEMPLATE = https://recorder-{node}.fleek.wootdev.com` (dev additionally sets
`RTSM_API_URL = https://core-a.rtsm.wootdev.com` and a `FLEEK_TOPOLOGY_JSON` whose `domain`
is `fleek.wootdev.com`). Reading a training service's own task-def env is the general way to
tell shared infra from per-env infra. Only Amplify-hosted `connect-web`
has no HTTP route at all. **Operator SSH** to the fleek/rtsm nodes needs a 12h cert —
`saws.js cert -n fleek -n rtsm -p dev_admin`, then `ssh -p 727 root@chi-1.fleek.wootdev.com` —
that is *not* needed for these HTTP probes.

`--ecs` adds the platform truth HTTP cannot see — running/desired tasks and rollout
state, so a crash-loop behind a still-healthy ALB target, or a stuck deploy, fails the
gate. It needs dev-account credentials; the default HTTP-only run needs none.

---

## 2. Read-only walkthrough (do this first — zero risk)

### T1 — `env list`
```bash
node $CLI env list --profile dev_admin
```
**Expect:** two rows — `dev (main) *.wootdev.com` with `ecr×… ecs×… routing×…`, and
`training (training) *.saga-training.org` with `db×14 …`. No error.

### T2 — `env discover`
```bash
node $CLI env discover --env dev --profile dev_admin
```
**Expect:** a filtered list of `/shared/infra/dev/*` and `/dev/*` data-store params, ending with
`jump host: i-… (tag Name=dev-shared-ecs-instance, Online)`.

### T2b — `env verify` (the health gate)
```bash
node $CLI env verify --env dev                      # HTTP only — needs no AWS credentials
node $CLI env verify --env dev --ecs --profile dev_admin   # + ECS running/desired + rollout
node $CLI env verify --env training --ecs --profile dev_admin
```
**Expect:** a ✓ line per healthy service showing the probed URL (and, with `--ecs`,
`· ecs N/N task(s) running`); ○ lines with a reason for the optional/dev-only ones; and
**`✓ verify passed — 16/16 service(s) healthy.`** on dev, **15/16** on training (only
`transcripts-api` is dev-only; rtsm/fleek/fleek-recorder are shared and green on both). Exit 0.

An in-flight ECS deploy (`rollout IN_PROGRESS`) at full task count is reported but does **not**
fail the gate; a FAILED rollout, under-running tasks, or scale-to-zero do.

**Negative check (proves the ALB trap is really handled)** — point it at a hostname that
isn't routed and confirm it is called out rather than passing:
```bash
curl -s https://programs.wootdev.com/health    # → `dev-account-alb` (the 200 that means nothing)
```
`programs.` (no `-api`) is exactly the shape that a status-code-only gate would score green;
verify's map deliberately uses `programs-api.`.

### T3 — `env connect` (open the tunnels)
Open each store in the background on its own local port (foreground holds until Ctrl-C):
```bash
for s in iam:15432 programs:15433 scheduling:15434 sessions:15435 ads-adm:15436 coach:15437; do
  store=${s%%:*}; port=${s##*:}
  node $CLI env connect $store --env dev --profile dev_admin --local-port $port &
done
# wait for each to print "✓ tunnel up"
```
**Expect per store:** `route: db-host i-… (CloudMap <service>, local dial :<port>)` then
`✓ tunnel up — 127.0.0.1:<local> → <service>.dbs-v2.local:<remote>` and a
`DATABASE_URL=postgres://…` line. Sanity: `node $CLI env connect iam --print-only` resolves
everything without opening a tunnel.

### T4 — `env org status` (footprint)
```bash
node $CLI env org status --org emptyOrg \
  --url iam=<IAM_URL> --url programs=<PGM_URL> --url scheduling=<SCH_URL> \
  --url sessions=<SES_URL> --url ads-adm=<ADS_URL> --url coach=<COA_URL>
```
**Expect:** `resolution: live`, `id-sets: groups=31 users=22 programs=7 …`, per-table counts,
`[projection]`-marked rows, and a footprint total. Baseline observed: **~980 org-reachable rows**
(sessions 463, programs 212, iam 152, scheduling 90, ads-adm 63, coach 0).

---

## 3. Reset walkthrough

### T5 — `env org reset --dry-run` (the safe proof; = the review gate)
```bash
node $CLI env org reset --org emptyOrg \
  --url iam=<IAM_URL> --url programs=<PGM_URL> --url scheduling=<SCH_URL> \
  --url sessions=<SES_URL> --url ads-adm=<ADS_URL> --url coach=<COA_URL> --dry-run
```
**Expect:** `▶ env org reset DRY RUN`, the org/env/kept/id-sets header, per-store per-table
`N row(s) will be DELETED`, and `✓ reset dry run complete — 980 row(s) would be deleted across
6 store(s); no changes made.` **Nothing is written** (every SQL that ran was a SELECT). Note
`deletable-users=0` on this org — its 22 users are multi-org/shared and are correctly kept
(only their Empty-Org memberships die).

### T6 — `env org reset --snapshot --yes` **[DESTRUCTIVE]**
Snapshot-first so there's an undo point, then delete:
```bash
node $CLI env org reset --org emptyOrg \
  --url iam=<IAM_URL> --url programs=<PGM_URL> --url scheduling=<SCH_URL> \
  --url sessions=<SES_URL> --url ads-adm=<ADS_URL> --url coach=<COA_URL> \
  --snapshot --profile dev_admin --yes
```
**Expect:**
1. `✓ snapshot <store> (<name>) → profile 'pre-org-reset'` for stores with a known registry name
   (iam, ads-adm out of the box; others warn "no registry name" unless `--snapshot-service` given).
2. `▶ N/6 <store> — … one transaction` then `✓ <store> reset` per store, leaf stores first, **iam last**.
3. Post-verify: no `⚠ … REMAIN` warnings; self-blinding tables (`"DayTypeBlock"`,
   `"ProgramSectionMapping"`) reported `verify indirect`, not a fake 0.
4. Final: `✓ Empty Org reset — ~980 row(s) deleted across 6 store(s); skeleton intact.` **Exit 0.**

**Skeleton check (pass criterion):** the run's own skeleton check must say **intact**. Independently
confirm the seed survived:
```bash
# via the iam tunnel
psql "<IAM_URL>" -Atc "SELECT display_name FROM groups WHERE id='52a00136-285b-522c-bc70-0887cf46463a'"  # → Empty Org
psql "<IAM_URL>" -Atc "SELECT username FROM users WHERE id='506605c6-f2c5-5785-9837-7970e7a2594c'"        # → empty
```

### T7 — the repeatable loop (the actual goal)
```
env verify --ecs   (services healthy before you trust a journey result)
env org status  (≈0 org-reachable rows beyond the skeleton)
→ run the saga-dash e2e journey against dev (Empty Org)
→ env org status  (footprint grows)
→ env org reset --snapshot --yes
→ env org status  (back to skeleton)
→ repeat
```
**Pass:** each cycle ends at the skeleton, the journey runs clean from a fresh Empty Org, and no
other org's counts ever change.

---

## 4. Negative / guard tests (all should REFUSE, non-zero, before touching data)

| # | Command | Expected refusal |
|---|---|---|
| N1 | `env org reset --org jennys-training-org --url iam=x --url programs=y --yes` | "not a resettable fixture org … deliberately untargetable" |
| N2 | `env org reset --org 52a00136-285b-522c-bc70-0887cf46463a …` (raw UUID) | same — slug-only targeting |
| N3 | `env org reset --org emptyOrg --url sessions=x --yes` (missing anchors) | "requires BOTH anchor stores … iam AND programs" |
| N4 | `env org reset --org emptyOrg --url iam= --url programs=p --yes` (empty conn) | "empty connection string" |
| N5 | `env org reset --org emptyOrg --url iam=<wrong-db> --url programs=… --yes` | "IDENTITY ASSERTION FAILED — … expected 'empty'" (points at a DB that isn't the seeded org) |
| N6 | `env org reset --org emptyOrg --url iam=… --url programs=… --snapshot --env training` | "--snapshot drives the dev db-host orchestrator … no orchestrator for 'training'" |
| N7 | `env org reset --org emptyOrg …` (interactive, no `--yes`) → answer `n` | "reset aborted — nothing changed" (exit 0, nothing deleted) |
| N8 | `env verify --env dev --org jennys-org --url iam=…` | "not a known fixture org" (slug guard applies to verify too) |
| N9 | `env verify --env dev --org emptyOrg` (no `--url iam=`) | "--org needs the iam connection" |
| N10 | `env list` / `env verify --ecs` with a **prod** profile (`--profile default`) | "AWS account mismatch — … pass --profile dev_admin" (not a cryptic ResourceNotFound) |

---

## 5. PRs

| PR / issue | What | State |
|---|---|---|
| **soa#356** | `ss env` — Phase 0 (list/discover/connect/org status), Phase 1 (`org reset`), **and `env verify`** (+`--ecs`). The whole deliverable under test here. | **OPEN (draft), mergeable** — `skelly/gh355-env-phase0 → main` |
| soa#355 | Epic: the `env` command family (design + phases). | OPEN (closed by #356) |
| soa#350 | `ss stack wipe --slot N` — same worktree lineage, unrelated to env. | MERGED |
| soa#352 | `ss stack wipe --slot all` — same lineage, unrelated to env. | MERGED |
| `~/dev/shared-env-reset-research.md` | Research: how these envs reset, SSM access, the org-purge design. | doc |

`#356` branched from `main` **after** #350/#352 merged, so it has no dependency on unmerged work.

---

## 6. Suggested drop order

`#356` currently bundles read-only Phase 0 with the destructive Phase 1. Recommended landing —
gate destructive capability behind a successful live run:

1. **Split & land Phase 0 first (low risk, immediately useful).** Carve `list`/`discover`/`connect`/
   `org status`/**`verify`** (+ their core: registry, seed-ids, footprint, taskdef, services, the
   aws/psql/prober seams) into a first merge. `verify` is pure-read and needs no credentials at all
   in its default form, so it is the safest, highest-value thing to land early. It's read-only, unblocks everyone's shared-env debugging, and de-risks the review of
   the destructive half. Gate: full suite green (already 1486/123), T1–T4 pass on dev.
2. **Close the `iam-pii` connect gap** (see §7) before Phase 1 merges — a complete reset needs it.
3. **Execute T5 → T6 → T7 on dev once** (real reset of Empty Org, skeleton verified, loop proven),
   then **land Phase 1 (`org reset`)** as the follow-up merge with that evidence attached.
4. **Phase 2 (separate, later):** service-side org purge that *emits delete events* (extend sis-api
   `demo.reset` → iam-api `service.demo.hardDeleteCsvUsers`), after which `env org reset` becomes an
   invoker + verifier + reconcile. Tracked under the epic.

If you'd rather keep it as one PR: merge `#356` whole **after step 3** (the live T6/T7 evidence),
since that's the only thing that meaningfully de-risks the destructive path.

---

## 7. Known gaps / notes to carry into review

- **`iam-pii` not connectable** via `env connect` (no footprint `STORES` entry / ecsService), so a
  fully-complete reset can't yet clear `user_pii`. `env org reset` warns + skips it. Cheap follow-up:
  add its ecsService (`rostering-iam-pii-*`) to the connect resolution.
- **`env verify` coverage: dev 16/16, training 15/16** — every mapped service is HTTP-verifiable;
  only `transcripts-api` is dev-only. rtsm/fleek/fleek-recorder are SHARED infra (one fleet, both
  envs); `connect-web` is per-env but on Amplify's own domain, so it is pinned by branch rather
  than templated off the env domain. Adding a service means editing `src/core/env/services.ts` — a
  reviewed change, because a wrong host silently reads as an ALB "down".
- **Known geo-node gap:** `nyc-1` (and `par-1` on rtsm) were unreachable on 2026-07-22 for BOTH
  fleek and rtsm, while chi-1/phx-1/vet-1/core-a/core-b answered. Verify probes ONE canonical node
  per fleet, so a single dead region will not fail the gate — worth confirming with Jeff/Seth
  whether those nodes are decommissioned or genuinely down, and whether verify should probe the
  whole fleet.
- **`coach = 0` rows** for Empty Org is expected (coach is consumer-only; the journey may seed no
  coach content) — not a miss.
- **Multi-org users** (`deletable-users=0` here) are kept by design; their org memberships are
  removed, their iam rows survive. Confirm this matches the "back to empty" you want for the loop.
- **`--output-json` + `--dry-run`:** dry-run emits human enumeration, not JSON (it returns before
  `emit`). Use a real (non-dry) run for machine-readable output.
- **Snapshot registry names:** only `iam` and `ads-adm` are known out of the box; supply the rest
  with `--snapshot-service <store>=<name>` once confirmed against the db-host-v2 registry (the
  program-hub trio may share one entry — verify before the first real `--snapshot`).
