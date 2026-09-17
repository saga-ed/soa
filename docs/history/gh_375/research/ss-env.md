# `ss env` — command surface as of I#375

Research capture for I#375 (`ss env production support`). Records the `env` topic exactly as it
exists **before** prod support, so the work has a baseline to diff against.

- CLI: `@saga-ed/saga-stack-cli` v1.0.0 (binaries `ss` / `saga-stack`)
- Source: `packages/node/saga-stack-cli/src/commands/env/`, `src/core/env/`
- Origin: the whole family landed in one commit, `9fd4f08` — *"Add the `ss env` command family —
  deployed shared-env debug, health, and org reset (soa#355)"*
- Captured: 2026-07-28, from live `--help` plus source read

> The `saga-iac` plugin reference (`references/saga-stack-cli.md`, v1.13.0) predates this family and
> does not document it. Live `--help` is the source of truth.

## What the topic is

> Deployed shared environments (dev `*.wootdev.com`, training `*.saga-training.org`): list, discover
> data-plane wiring, and open SSM tunnels to the underlying stores.

`ss env` addresses **deployed** environments — as distinct from `ss stack`, which drives the local
synthetic stack. The two topics share flag plumbing but not subject matter.

## Topic structure

```
ss env
├── list        read-only   registry + dev-platform ledger footprint
├── discover    read-only   SSM data-plane wiring + jump host
├── connect     read-only   SSM port-forward to Postgres, prints DATABASE_URL
├── verify      read-only   health gate, judged by response BODY
└── org                     org-scoped ops — fixture orgs only, catalog-slug targeting
    ├── status  read-only   per-table row-count footprint across mesh Postgres
    └── reset   DESTRUCTIVE delete a fixture org back to its seeded skeleton
```

Seven commands: five leaf commands at the top level (four, plus the `org` sub-topic's two), one
nested topic. Six of the seven are read-only; `env org reset` is the only mutating command.

## The seven commands

### 1. `ss env list`

> List deployed shared environments (dev, training) and their dev-platform ledger footprint.
> Read-only.

No `--env` flag — it enumerates the registry rather than targeting one entry. Reads the
dev-platform control-plane ledger (DynamoDB table `dev-platform-control-plane-environments-dev`).

```
ss env list
ss env list --profile dev_admin --output-json
```

**Observed behavior with prod credentials** (2026-07-28): fails the account preflight —

```
AWS account mismatch — your credentials resolve to account 531314149529, but the env ledger
lives in 396913734878 (the dev account). Pass --profile <a dev-account profile>
(e.g. dev_admin) or set AWS_PROFILE, then retry.
```

### 2. `ss env discover`

> Discover a shared environment's data-plane wiring: SSM params under its discovery roots (filtered
> to data-store names) and the Online SSM jump host. Read-only.

| Flag | Default | Notes |
|---|---|---|
| `--env` | `dev` | `dev \| training` |
| `--filter` | `postgres\|mongo\|mongodb\|db-host\|rabbit\|redis\|rds\|secret` | case-insensitive regex over parameter names |

```
ss env discover --env dev --profile dev_admin
ss env discover --env dev --filter mongodb
```

### 3. `ss env connect STORE`

> Open an SSM port-forward to a shared environment's Postgres, resolved from the service's live ECS
> task definition, and print a ready `DATABASE_URL`. Holds until Ctrl-C; `--print-only` resolves
> without connecting.

**Argument:** `STORE` — one of `iam | programs | scheduling | sessions | ads-adm | coach`.

| Flag | Default | Notes |
|---|---|---|
| `--env` | `dev` | `dev \| training` |
| `--print-only` | | resolve and print everything, do not open the tunnel |
| `--local-port` | `15432` | local end of the tunnel |
| `--host` | | remote DB endpoint; skips task-definition resolution |
| `--remote-port` | `5432` | remote DB port, used with `--host` |
| `--database` | | override the resolved database name |
| `--username` | | override the resolved user (URL then carries no password) |

```
ss env connect iam --env dev --profile dev_admin
ss env connect programs --env dev --local-port 15433
ss env connect iam --host mydb.dbs-v2.local --remote-port 5440 --database rostering-iam-canonical --print-only
```

The db-host-v2 tunnel path is non-obvious and documented in `registry.ts`: the shared jump host's
security group cannot reach the per-service DB containers (task-SG allowlists — a dial from the jump
host hangs on a dropped SYN, verified live 2026-07-21). Tunnels therefore route via CloudMap —
`discover-instances` → the container's own host instance and port → SSM to *that* instance with a
`127.0.0.1` dial, keeping no SG in the path.

### 4. `ss env verify`

> Health-gate a deployed shared environment (dev/training): probe every service's health endpoint
> and judge it by RESPONSE BODY (the shared ALB answers 200 for unrouted hosts). Non-zero exit if a
> required service is unhealthy. `--org` additionally asserts a fixture org's seed skeleton.

Body-based judgment is the load-bearing detail: status codes are useless here because the shared ALB
answers 200 for hosts it has no route for.

| Flag | Notes |
|---|---|
| `--env` | `dev \| training` (default `dev`) |
| `--ecs` | ALSO check ECS platform state (running/desired tasks, rollout) — the truth HTTP cannot see: crash-loops behind a healthy target, stuck deploys, and services with no public route. Needs dev-account AWS credentials. |
| `--tolerate` | comma-separated service ids whose being down does not fail the gate |
| `--org` | also assert this fixture org's seed skeleton (`emptyOrg`); requires `--url iam=<conn>` |
| `--url` | store connection as `<store>=<connString>` (only `iam` is used, for `--org`) |

```
ss env verify --env dev
ss env verify --env training --tolerate connect-api,rtsm-api
ss env verify --env dev --org emptyOrg --url iam=postgres://…15432/iam
```

### 5. `ss env org status --org <slug>`

> Show a fixture org's data footprint across the mesh's Postgres stores (per-table row counts,
> projections marked). Read-only; targets orgs by catalog slug only.

| Flag | Notes |
|---|---|
| `--org` | **required** — fixture org slug (`emptyOrg`) |
| `--offline` | catalog-derived ids only; no live id resolution even if anchor URLs are given |
| `--url` | `<store>=<connString>`, repeatable |

```
ss env org status --org emptyOrg --url iam=postgres://…15432/iam --url programs=postgres://…15433/programs
ss env org status --org emptyOrg --offline
```

Note this command takes no `--env` — it works off the `--url` connections you supply (typically from
`ss env connect`), or purely offline from the seed-id catalog.

### 6. `ss env org reset --org <slug>` — DESTRUCTIVE

> DELETE a fixture org's data across the shared environment's Postgres stores, back to the seeded
> skeleton (org row + admin + seeded personas survive). Destructive; slug-only targeting,
> identity-asserted, one confirm, per-store transactions, post-verified.

| Flag | Notes |
|---|---|
| `--org` | **required** — fixture org slug (`emptyOrg`) |
| `--env` | `dev \| training` (default `dev`) |
| `--dry-run` | resolve id-sets, run the identity assertion, print exactly what would be deleted (per-table counts), exit 0 without deleting |
| `--yes` | non-interactive: skip the destructive-action prompt (CI / agents) |
| `--url` | `<store>=<connString>`, repeatable. Store keys: `sessions, scheduling, programs, ads-adm, coach, iam-pii, iam`. **`iam` AND `programs` are mandatory anchors**; other stores without a `--url` are skipped with a warning |
| `--snapshot` | best-effort pre-delete snapshot per store via the db-host-v2 orchestrator (profile `pre-org-reset`, versioned). Unreachable orchestrator ⇒ warn and proceed; an unknown registry name skips that store |
| `--snapshot-service` | db-host-v2 registry serviceName override as `<store>=<serviceName>`, repeatable, with `--snapshot` |

```
ss env org reset --org emptyOrg --url iam=… --url programs=… --dry-run
ss env org reset --org emptyOrg --url iam=… --url programs=… --url sessions=… --url scheduling=… --yes
ss env org reset --org emptyOrg --url iam=… --url programs=… --snapshot --profile dev_admin
```

Guardrails, stacked: slug-only targeting (never a raw org id), an org-identity pre-flight assertion,
a dry-run enumeration mode, one confirm prompt, per-store transactions, and post-verification.

### 7. `ss env org` (topic)

> Org-scoped operations against a shared environment's data stores — fixture orgs only
> (catalog-slug targeting).

Carries `status` and `reset` above.

## Flags shared by the whole family

Every `env` command inherits the standard `ss` flag set:

- `--output-json` — structured JSON on stdout instead of human-readable text
- `--porcelain` — machine-readable, no color, minimal noise
- `--dev` — sibling-repo workspace root
- per-repo path overrides: `--soa --sds --coach --fleek --rostering --rtsm --saga-dash --program-hub --qboard`
- `--set` — worktree set (M13)
- `--slot` — stack instance slot 0–9
- `--state-dir` — scratch dir for run state

`--set`, `--slot`, and `--state-dir` are inherited plumbing from the `stack` topic; they carry no
meaning for a deployed environment.

Two flags are **not** universal — verified against live `--help` (2026-07-28):

| Command | `--env` | `--profile` |
|---|---|---|
| `env list` | ✗ (enumerates the registry) | ✓ |
| `env discover` | ✓ | ✓ |
| `env connect` | ✓ | ✓ |
| `env verify` | ✓ | ✓ (for `--ecs`) |
| `env org status` | ✗ | ✗ |
| `env org reset` | ✓ | ✓ (for the `--snapshot` Lambda call) |

`env org status` is the outlier: it takes neither, working purely off supplied `--url` connections or
the offline seed-id catalog. Anything that teaches the family about prod must not assume `--env` is
present on every command.

## The registry — and why prod is absent

`src/core/env/registry.ts` (106 lines, pure data + lookups; all AWS IO sits behind the
`runtime/aws-cli.ts` seam). Its header is explicit:

> `dev` (the `*.wootdev.com` fleet, CI-deployed on merge to main) and `training` (the persistent
> `*.saga-training.org` tenant) ship built in; both live in the SAME dev AWS account — **prod is a
> different account and deliberately NOT representable here.**

Module-level constants — the ones that assume a single account:

| Constant | Value |
|---|---|
| `DEV_ACCOUNT_ID` | `396913734878` |
| `LEDGER_TABLE` | `dev-platform-control-plane-environments-dev` |
| `JUMP_HOST_NAME_TAG` | `dev-shared-ecs-instance` |
| `ECS_CLUSTERS` | `['dev-shared-arm', 'dev-shared']` (arm carries most of the mesh, live 2026-07-21) |
| `DB_HOST_CLOUDMAP_NAMESPACE` | `dbs-v2.local` |

The `DeployedEnv` interface, per environment: `name`, `ledgerIdentifier`, `domain`, `awsRegion`,
`awsAccountId`, `ssmDiscoveryRoots`, `description`.

| | `dev` | `training` |
|---|---|---|
| `ledgerIdentifier` | `main` | `training` |
| `domain` | `wootdev.com` | `saga-training.org` |
| `awsRegion` | `us-west-2` | `us-west-2` |
| `awsAccountId` | `396913734878` | `396913734878` |
| `ssmDiscoveryRoots` | `['/shared/infra/dev', '/dev']` | `['/shared/infra/dev', '/dev']` |

Deploy posture differs: dev is CI-deployed on merge to main and data accumulates (no reset);
training is manual-dispatch deploy, whole-DB reset via `reset-training-data.yml` in rostering only.

`accountMismatchError(callerAccount, expectedAccountIds, label)` preflights every command and
returns an actionable "wrong account — switch profile" string. It does not block when the account
cannot be read.

`ENV_NAMES = Object.keys(DEPLOYED_ENVS)` drives the `--env` help text, so a third entry propagates
to help automatically — but nothing else does.

**Consequence for I#375:** a third `DEPLOYED_ENVS` entry is necessary but not sufficient. Ledger
table, jump host tag, ECS cluster list, and CloudMap namespace are all module-level and must become
per-env fields on `DeployedEnv` before `prod` can mean anything.

## Prod-side facts gathered (unverified live)

From the `iac` repo and `~/.aws/config`:

- Account `531314149529`, region `us-west-2`. Profiles: `prod_admin` (AdministratorAccess),
  `saga-runtime-prod` (AppRuntime), `saga` (Observer).
- SSM discovery root `/shared/infra/prod` — `cloudformation_templates/openfga/samconfig.yaml`.
- ECS cluster stack `prod-shared-ec2-cluster` —
  `cloudformation_templates/ecs/cluster/samconfig.yaml`. Dev has both `dev-shared-ec2-cluster` and
  `dev-shared-ec2-cluster-arm`; prod's samconfig shows **no arm counterpart**.
- Public apex `my.saga.org` / `my.sagaeducation.org` — prod is not a single-apex fleet the way
  `wootdev.com` and `saga-training.org` are, which affects how `verify` enumerates service hosts.

Open questions carried into the issue: whether prod has a dev-platform ledger entry at all; live
prod cluster names; the prod jump host Name tag (`prod-shared-ecs-instance` by symmetry, unverified);
whether db-host-v2 exists in prod or prod is on RDS (which would change `connect`'s resolution path
materially); and the floor credential tier for prod `connect`.

## Interop target for I#375

Full-featured interoperability across `dev`, `training`, and `prod` — with one deliberate exception.
`env org reset` is fixture-org-scoped and slug-only; "fixture org" has no clean prod analogue. The
default position is that it **refuses `--env prod`** explicitly. Every other command should reach
parity.

| Command | dev | training | prod target |
|---|---|---|---|
| `env list` | ✅ | ✅ | include prod in the listing |
| `env discover` | ✅ | ✅ | ✅ parity |
| `env connect` | ✅ | ✅ | ✅ parity, prod credential tier gate |
| `env verify` | ✅ | ✅ | ✅ parity, multi-apex host enumeration |
| `env org status` | ✅ | ✅ | ✅ read-only, works off `--url` |
| `env org reset` | ✅ | ✅ | ⛔ refuse by design |
