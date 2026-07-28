# gh_375 — `ss env` production support: plan

_Issue: [I#375](https://github.com/saga-ed/soa/issues/375). Baseline command surface is captured in
`../research/ss-env.md`; live prod discovery is in `../research/prod-facts.md`._

## Goal

`ss env` reaches full-featured interoperability across `dev`, `training`, and `prod` — every command
that is *meaningful* in prod accepts `--env prod`, resolves prod's control plane and data plane
correctly, and enforces a prod-appropriate safety posture. Env stays a **parameter**, never a
hardcode.

One deliberate exception: `env org reset` **refuses** `--env prod`. Full-featured interop means every
meaningful command works — not that a destructive fixture-reset gets pointed at real tenant data.

## Status (2026-07-28)

- 🔵 **Planning. No code written.** Branch `gh_375` off `origin/main` (4079d53), worktree
  `/home/skelly/dev/soa/.claude/worktrees/gh375-env-prod`.
- ✅ **Four of the issue's five open questions answered live** against account `531314149529` with
  `prod_admin` (read-only). See below — one answer (Q4) **changes the shape of Phase 2 materially**.
- ✅ **Prod's host shape established by live HTTPS probing** (no AWS creds needed), which **refuted
  the issue's multi-apex premise** — prod is single-apex `saga.org` on dev's exact
  `<host>.<domain>` convention. This retired the plan's highest risk. See Q6.
- ⏳ **One hard blocker left:** the ECS service names on `prod-shared`. Secondary: the prod ALB
  host-header rules, now needed only to resolve five services that NXDOMAIN at the dev-convention
  hostname.

---

## What live discovery settled

| # | Open question | Answer | Evidence |
|---|---|---|---|
| 1 | Does prod appear in a dev-platform ledger? | **No — nowhere.** The dev ledger holds 784 distinct `pk`s; `ENV#main` and `ENV#training` are both there, **zero** match `prod`. The prod account has no `*-control-plane-environments-*` table at all (9 DynamoDB tables, none a control plane). | `dynamodb scan` on `dev-platform-control-plane-environments-dev`; `dynamodb list-tables` in 531314149529 |
| 2 | Live prod ECS cluster names — is there an arm cluster? | **`prod-shared` exists; there is no `prod-shared-arm`.** The iac samconfig asymmetry is real, not an omission. (A legacy `prod-apis` cluster also exists and is *not* the shared mesh.) | `ecs list-clusters` |
| 3 | Prod SSM jump host Name tag | **`prod-shared-ecs-instance` — confirmed.** Four running instances carry the tag. Symmetry held. | `ec2 describe-instances`, running only |
| 4 | db-host-v2 in prod, or RDS? | **No db-host-v2.** Prod has **no `dbs-v2.local` namespace** — its DNS_PRIVATE namespaces are `dbs.internal` and `db_temp`. Dev has both `dbs` and `dbs-v2.local`. Prod exposes `/shared/infra/prod/postgres-{endpoint,port,resource-id,master-secret-arn,sg-id}`, which is the RDS parameter shape. **Prod Postgres is RDS.** | `servicediscovery list-namespaces` (both accounts); `ssm describe-parameters` under `/shared/infra/prod` |
| 5 | Floor credential tier for prod `connect` | **Decided:** Observer reads (`list`/`discover`/`verify`); `connect` requires a prod-capable profile. | policy decision, 2026-07-28 |
| 6 | *(not in the issue)* Prod apex + host shape | **Single-apex `saga.org`, same `<host>.<domain>` convention as dev.** `iam.saga.org/health` answers `{"status":"ok","service":"IAM API"}`. Prod has **no wildcard DNS**, so dev's false-green ALB problem is absent. Five services NXDOMAIN at the dev-convention name. | live HTTPS probes, no AWS creds |

### Why Q4 is the load-bearing finding

`connect`'s whole reason for the CloudMap dance is a dev-only constraint: the shared jump host's SG
cannot reach per-service DB *containers*, so tunnels resolve `discover-instances` → the container's
own host instance + port → SSM to *that* instance with a `127.0.0.1` dial. **An RDS endpoint has none
of that problem.** Prod `connect` is the *simpler* path — SSM port-forward from the jump host
straight to the RDS endpoint on 5432 — not a port of the dev path.

So Phase 2 is not "make CloudMap work in prod". It is "teach `connect` that an env has a **data-plane
style**, and give prod the RDS style." That is a cleaner change than the issue assumed.

---

## Phase 0 — registry generalization (no behavior change)

Move the four module-level constants onto `DeployedEnv`, keeping dev/training values byte-for-byte
identical. Nothing observable changes; this is the enabling refactor.

**`src/core/env/registry.ts`** — add to `DeployedEnv`:

| New field | dev | training | Replaces |
|---|---|---|---|
| `ledgerTable?: string` | `dev-platform-control-plane-environments-dev` | same | `LEDGER_TABLE` |
| `jumpHostNameTag: string` | `dev-shared-ecs-instance` | same | `JUMP_HOST_NAME_TAG` |
| `ecsClusters: readonly string[]` | `['dev-shared-arm', 'dev-shared']` | same | `ECS_CLUSTERS` |
| `dbHostNamespace?: string` | `dbs-v2.local` | same | `DB_HOST_CLOUDMAP_NAMESPACE` |

`ledgerTable` and `dbHostNamespace` are **optional on purpose** — their absence is exactly how prod
is modelled in Phases 1 and 2. `DEV_ACCOUNT_ID` has zero consumers outside the registry and can be
inlined into the two entries or kept as a private const.

**Call sites to rewrite** (all in `src/commands/env/`, all mechanical — constant → `env.<field>`):

- `list.ts:16,57` — `LEDGER_TABLE`
- `discover.ts:16,82,89,90` — `JUMP_HOST_NAME_TAG`
- `connect.ts:32,33,35,126,127,134,136,183,199,235,241` — all three of namespace, clusters, tag
- `verify.ts:31,142` — `ECS_CLUSTERS`

`list.ts` is the one non-mechanical case: it queries a single `LEDGER_TABLE` for all envs and
preflights against the union of accounts. Restructure it to group envs **by ledger table**, which is
what makes Phase 1's prod case expressible at all.

**Tests** (`src/core/env/__tests__/`): a new `registry.unit.test.ts` pinning both existing envs
field-for-field. This is the regression net for the whole issue — write it *before* the prod entry
lands, and assert literal strings rather than re-deriving them from the module.

**Exit criteria:** `pnpm typecheck` clean; full suite green; `ss env list / discover / verify --env
dev` output diffs empty against `main`.

## Phase 1 — read-only prod (`list`, `discover`, `verify`)

Add the `prod` entry:

```ts
prod: {
    name: 'prod',
    ledgerIdentifier: 'prod',        // identity, NOT a ledger key — prod is not ledger-tracked
    domain: 'saga.org',                // single apex, confirmed live — NOT my.saga.org
    awsRegion: 'us-west-2',
    awsAccountId: '531314149529',
    ssmDiscoveryRoots: ['/shared/infra/prod'],
    jumpHostNameTag: 'prod-shared-ecs-instance',
    ecsClusters: ['prod-shared'],
    // ledgerTable and dbHostNamespace deliberately absent
    description: 'Production (*.saga.org) — not dev-platform ledger-tracked; RDS Postgres.',
}
```

**`list` — the "no ledger footprint" path.** Q1 says prod is not ledger-tracked anywhere, so
`ledgerTable: undefined` must render as an explicit, non-alarming `not ledger-tracked (prod is not a
dev-platform environment)` line — **not** an error, and **not** a silent blank that reads like "zero
resources". Because the ledger lives only in the dev account, the account preflight becomes
per-table rather than per-registry: query the dev ledger with dev credentials, list prod's registry
row with no prod credential requirement at all. Concretely, `expectedAccounts` at `list.ts:44`
narrows to the account set of the envs that *have* a ledger table.

**`discover`** should work with only the registry change — it walks `ssmDiscoveryRoots` and resolves
the jump host by tag, both now per-env and both confirmed live.

**`verify` — the multi-apex problem does not exist.** The issue's premise here was wrong, and live
probing refuted it (see `../research/prod-facts.md`, Q6). Prod serves the **same** `<host>.<domain>`
convention as dev, on the single apex `saga.org`: `iam.saga.org/health` answers
`{"status":"ok","service":"IAM API"}`. `my.saga.org` is a user-facing SPA, not the API apex — that is
what made prod *look* multi-apex. `sagaeducation.org` is not a service apex at all (every probed
subdomain NXDOMAINs).

So `buildEnvHealthProbes(env.domain, env.name)` works **unchanged** with `domain: 'saga.org'`. No
`fqdnByEnv.prod` entries are needed for the core fleet, no ALB-rule discovery, no curated prod host
table. This deletes what was the plan's highest risk.

Two consequences still need code:

1. **Prod runs a smaller service set.** Five services NXDOMAIN at the dev-convention hostname —
   `content-api`, `ads-adm-api`, `coach-api`, `transcripts-api`, `connectv3-api` — while
   `coach.saga.org` (the SPA) does serve. `DEPLOYED_SERVICES` is one global list, so
   `verify --env prod` would fail the gate on five services that may never be meant to be there.
   Add a per-service **env scope** — `envs?: readonly string[]`, absent meaning "all envs" — and have
   `buildEnvHealthProbes` skip services out of scope for the target env. Do *not* just mark them
   `optional`: that would weaken the dev gate too.
   Whether those five are genuinely absent from prod or deployed under different hostnames is the
   one open question the ALB host-header rules still need to answer. The
   `/shared/infra/prod/internal-services-alb-*` parameters suggest a public/internal split, in which
   case some are internal-only and HTTP-unverifiable *by design*.
2. **Prod has no wildcard DNS**, so dev's false-green problem is absent — an unrouted prod host
   NXDOMAINs rather than returning `200 dev-account-alb`. Keep body judgment (it is still correct,
   and `HEALTHY_STATUSES` already covers prod's vocabulary — `sis` answers `running`), but note that
   `ALB_DEFAULT_MARKER` is dev-specific and has no confirmed prod analogue. It should not be
   generalized to prod on the assumption that one exists.

**`--ecs` in prod.** `verify.ts:140` builds the service name as `${ecsService}-${env.ledgerIdentifier}`.
Prod's suffix is currently a guess — this is the second unverified fact. Confirm with `aws ecs
list-services --cluster prod-shared` before writing anything; if prod's naming does not follow the
`-<identifier>` suffix, add an explicit `ecsServiceSuffix?: string` to `DeployedEnv` rather than
overloading `ledgerIdentifier` to mean two different things.

**Exit criteria:** `ss env list` shows three envs with dev creds and no error; `ss env discover --env
prod --profile prod_admin` resolves the jump host and data-store params; `ss env verify --env prod`
reports every service either healthy or explicitly unverifiable, with zero false greens.

## Phase 2 — `connect --env prod` (RDS path)

Branch `connect`'s target resolution on the data-plane style the registry now carries:

- **`dbHostNamespace` present (dev/training)** → today's CloudMap path, unchanged.
- **`dbHostNamespace` absent (prod)** → resolve the Postgres endpoint from
  `/shared/infra/prod/postgres-endpoint` (+ `postgres-port`) and SSM port-forward from the
  `prod-shared-ecs-instance` jump host to that endpoint. No `discover-instances`, no `127.0.0.1`
  dial, no per-container host resolution.

The task-definition resolution in `taskdef.ts` (`extractDbTarget`) stays useful for prod — it is how
`connect` learns the **database name and user** per store. What changes is only the *reachability*
step after the target is known. Keep the existing `--host` / `--remote-port` overrides working as the
escape hatch for both styles.

**Credential gate (Q5) — proposal for review.** Read-only commands (`list`, `discover`, `verify`)
accept the Observer tier (`saga`); they read SSM parameter *names*, EC2 tags, and HTTP health bodies.
`connect` opens a live tunnel to production tenant data and should require an explicitly
prod-capable profile, refusing Observer with the same actionable "switch profile" wording. **`--print-only`
becomes the documented default habit for prod** — prod examples in `connect.ts` show it first, and
human-readable prod output carries a one-line "this is production" banner.

`accountMismatchError` needs no signature change: it is already called per-env with
`[env.awsAccountId]`, so prod commands demand prod credentials and dev commands demand dev
credentials automatically. Only its message *text* is dev-specific — `"(the dev account)"` and
`"e.g. dev_admin"` are hardcoded at `registry.ts:100-101` and must become parameterized.

**Exit criteria:** `ss env connect iam --env prod --print-only --profile prod_admin` prints a correct
`DATABASE_URL` shape without opening anything; a live tunnel round-trips a `SELECT 1`; Observer tier
is refused with an actionable message.

## Phase 3 — safety posture for `env org reset`

`env org reset --env prod` **hard-refuses**, before any resolution, connection, or prompt:

```
env org reset does not operate on production. Fixture orgs (emptyOrg) are a
synthetic-dev construct with no prod analogue, and this command deletes tenant
data. There is no --force. (I#375)
```

Placement matters: the refusal goes immediately after `resolveEnv` at `reset.ts:152`, **before** the
`--url` parsing and anchor guards, so no prod connection string is ever read, logged, or dialed.
Implement it as a `resetForbidden?: true` field on `DeployedEnv` rather than a `name === 'prod'`
string test — env stays a parameter, and any future env inherits the posture by declaration.

`env org status` is read-only and takes no `--env` at all (it works off supplied `--url`s), so it
needs no change and gains prod support for free.

The existing `--snapshot` guard at `reset.ts:154` already refuses any env that is not `dev`, so prod
is doubly covered there. Leave it; do not widen it.

**Never widen `org reset`'s targeting as a side effect of this issue.** The slug-only catalog
(`RESETTABLE_ORGS` = `emptyOrg` only) stays exactly as-is; `env-core.unit.test.ts:48` pins it.

**Exit criteria:** an integration test asserts `--env prod` exits non-zero with the refusal text and
that no psql invocation and no AWS call is made; the dev/training reset paths are untouched.

## Phase 4 — docs

- `ss env` help text and examples gain prod cases (`--print-only` first for `connect`).
- Record the prod facts table above in `docs/` so the next reader does not re-derive it from AWS.
- The `saga-iac` plugin reference `references/saga-stack-cli.md` still predates the whole `env`
  family (noted in the research capture) — worth a follow-on issue rather than scope creep here.

---

## Command-by-command target

| Command | dev | training | prod target |
|---|---|---|---|
| `env list` | ✅ | ✅ | listed, with an explicit "not ledger-tracked" footprint line |
| `env discover` | ✅ | ✅ | parity (registry change only) |
| `env connect` | ✅ | ✅ | parity via the **RDS** path + credential-tier gate |
| `env verify` | ✅ | ✅ | parity via per-service `fqdnByEnv.prod`; unmapped = unverifiable |
| `env org status` | ✅ | ✅ | free — no `--env`, works off `--url` |
| `env org reset` | ✅ | ✅ | ⛔ refused by design |

## Constraints carried from the issue

- **AWS via shell-out to the `aws` CLI only** — the CLI stays SDK-free (I#214 stance, carried through
  I#355). Every new call goes through the `runtime/aws-cli.ts` seam.
- `accountMismatchError()` keeps working per-env, both directions.
- Nothing new hardcodes a hostname that can drift — endpoints stay discovered live or overridden per
  invocation. The prod facts table above is *documentation*, not config.
- 4-space indentation; tests for every new behavior; pnpm only.

## Risks

1. ~~The prod `verify` host map is the highest-risk artifact.~~ **Retired.** Live probing showed prod
   uses dev's `<host>.<domain>` convention on a single apex, so there is no map to curate and no
   guessing to do.
2. **The five absent services** are the live unknown: genuinely not in prod, or deployed under
   different hostnames? Handling them as "out of env scope" when they are actually deployed-but-
   renamed would mean `verify --env prod` silently skips real services. The ALB host-header rules
   settle it; until then, prefer reporting them as unverifiable over dropping them.
3. **ECS service naming on `prod-shared`** is unconfirmed and decides a code branch in
   `verify --ecs`. Guessing it would silently skip the platform check.
4. **`list`'s account-preflight restructure** is the one place Phases 0/1 can regress existing
   behavior. The Phase 0 registry test plus a `list`-specific test pinning dev+training output are
   the net.

## Sequencing

Phase 0 and Phase 1 are one reviewable PR each. Phase 2 depends on confirming the RDS endpoint.
Phase 3 is independent of 1 and 2 — and landing it **first** is the safest order, because it closes
the destructive path before prod is reachable at all.
