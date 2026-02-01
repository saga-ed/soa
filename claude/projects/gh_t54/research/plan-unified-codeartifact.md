# Plan: Consolidate to Single CodeArtifact Repository `saga_js`

## Objective

Migrate all repos from two separate CodeArtifact repositories (`saga_soa`, `saga_nimbee`) to a single unified repository **`saga_js`**, simplifying authentication and permission management.

**Success criteria**: link:off builds for coach, thrive, and nimbee resolve `@saga-ed/*` and `@nimbee/*` packages from `saga_js`. Link:on builds continue to use locally-built SOA artifacts.

---

## Current State

| Scope | CodeArtifact Repo | Published From | Consumed By |
|-------|-------------------|----------------|-------------|
| `@saga-ed/*` | `saga_soa` | soa | coach, thrive, nimbee |
| `@nimbee/*` | `saga_nimbee` | nimbee | nimbee (saga_api) |

**Domain**: `saga` (account `531314149529`, us-west-2)

---

## Target State

| Scope | CodeArtifact Repo | Published From | Consumed By |
|-------|-------------------|----------------|-------------|
| `@saga-ed/*` | **`saga_js`** | soa | coach, thrive, nimbee |
| `@nimbee/*` | **`saga_js`** | nimbee | nimbee (saga_api) |

Single auth token, single repository, single `.npmrc` pattern across all repos.

---

## Phase 0: Prerequisites (AWS)

The `saga_js` repository already exists. Verify access and upstream configuration:

```bash
# Confirm the repository exists and check its configuration
aws codeartifact describe-repository \
    --domain saga \
    --domain-owner 531314149529 \
    --repository saga_js \
    --region us-west-2

# Check upstream repositories (should include npmjs for public package pass-through)
aws codeartifact list-repositories-in-domain \
    --domain saga \
    --domain-owner 531314149529 \
    --region us-west-2

# Verify auth works — get a token and confirm login succeeds
aws codeartifact login --tool npm \
    --domain saga \
    --domain-owner 531314149529 \
    --repository saga_js \
    --region us-west-2
```

**Verify upstream behavior**: If `saga_js` has `npmjs` configured as an upstream, public npm packages will resolve through CodeArtifact. Confirm this is the desired behavior or add the upstream if missing:

```bash
# Check current upstreams
aws codeartifact list-package-version-assets \
    --domain saga --domain-owner 531314149529 \
    --repository saga_js --region us-west-2 \
    --format npm --package zod --package-version 3.25.67 2>/dev/null \
    && echo "npmjs upstream active" || echo "npmjs upstream NOT configured"

# If npmjs upstream is needed:
aws codeartifact update-repository \
    --domain saga --domain-owner 531314149529 \
    --repository saga_js --region us-west-2 \
    --upstreams repositoryName=npmjs
```

**Verify IAM permissions**: Confirm `github-actions-role/SOADeployRole` has publish/read permissions on `saga_js` (not just `saga_soa` and `saga_nimbee`).

---

## Phase 1: SOA (branch `gh_t54`)

### 1.1 Update `.npmrc`

**File**: `/home/skelly/dev/soa/.npmrc`

```
# Before
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/
@hipponot:registry=https://npm.pkg.github.com

# After
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
@hipponot:registry=https://npm.pkg.github.com
```

### 1.2 Update `publishConfig` in all package.json files

**Files** (all publishable packages):
- `packages/node/api-core/package.json`
- `packages/node/api-util/package.json`
- `packages/node/aws-util/package.json`
- `packages/node/db/package.json`
- `packages/node/logger/package.json`
- `packages/node/pubsub-client/package.json`
- `packages/node/pubsub-core/package.json`
- `packages/node/pubsub-server/package.json`
- `packages/node/rabbitmq/package.json`
- `packages/node/redis-core/package.json`
- `packages/core/config/package.json`
- `packages/core/trpc-codegen/package.json`
- `packages/core/tgql-codegen/package.json`
- `build-tools/zod2ts/package.json`

**Change** (each file):
```json
// Before
"publishConfig": {
    "registry": "https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/",
    "access": "public"
}

// After
"publishConfig": {
    "registry": "https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/",
    "access": "public"
}
```

Note: Some packages (typescript-config, pubsub-server) use GitHub Packages registry. Review each — if they should also move to `saga_js`, update accordingly.

### 1.3 Update CI workflow: `publish-codeartifact.yml`

**File**: `.github/workflows/publish-codeartifact.yml`

Replace all occurrences of `saga_soa` with `saga_js`:

```yaml
# Before
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_soa

# After
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js
```

Also update any `--repository` flags and registry URLs in the workflow.

### 1.4 Update CI workflow: `publish-all-packages.yml`

**File**: `.github/workflows/publish-all-packages.yml`

Same pattern — replace `saga_soa` → `saga_js` in any CodeArtifact references.

### 1.5 Update documentation

**Files**:
- `docs/cicd-package-publishing.md`
- `docs/cross-repo-linking-summary.md`

Update registry references from `saga_soa` to `saga_js`.

---

## Phase 2: Coach (branch `gh_t54`)

### 2.1 Create `.npmrc`

**File**: `/home/skelly/dev/coach/.npmrc` (NEW)

```
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
//saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:always-auth=true
```

### 2.2 Verify `soa-link.json`

**File**: `/home/skelly/dev/coach/soa-link.json`

No changes needed — the link config uses filesystem paths, not registry URLs.

### 2.3 Verify `cross-repo-link.sh` scripts

No changes needed in coach — the `soa:link` scripts call into soa's script.

### 2.4 CI workflow updates

Review coach CI for any hardcoded `saga_soa` references and update to `saga_js`.

---

## Phase 3: Thrive (branch `gh_t54`)

### 3.1 Create `.npmrc`

**File**: `/home/skelly/dev/thrive/.npmrc` (NEW)

```
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
//saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:always-auth=true
```

### 3.2 Verify `soa-link.json`

No changes needed — same as coach.

### 3.3 CI workflow updates

Review thrive CI for any hardcoded `saga_soa` references and update to `saga_js`.

---

## Phase 4: Nimbee (branch `gh_7763`)

Nimbee is the most complex case — it consumes `@saga-ed/*` packages AND publishes `@nimbee/*` packages. Additionally, nimbee will **migrate from its legacy `scripts/soa-link.sh`** to SOA's canonical `cross-repo-link.sh` + `soa-link.json` pattern, aligning with coach and thrive.

### 4.1 Update root `.npmrc`

**File**: `/home/skelly/dev/nimbee/.npmrc`

```
# Before
registry=https://registry.npmjs.org/
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/
//saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/:always-auth=true

# After
registry=https://registry.npmjs.org/
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
@nimbee:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
//saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:always-auth=true
```

### 4.2 Update `ars_lib/.npmrc`

**File**: `/home/skelly/dev/nimbee/edu/js/lib/ars_lib/.npmrc`

```
# Before
@nimbee:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_nimbee/

# After
@nimbee:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

### 4.3 Update `saga_api/.npmrc`

**File**: `/home/skelly/dev/nimbee/edu/js/app/saga_api/.npmrc`

```
# Before
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/
@nimbee:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_nimbee/

# After
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
@nimbee:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

### 4.4 Create `soa-link.json` (NEW — replaces legacy script)

**File**: `/home/skelly/dev/nimbee/soa-link.json` (NEW)

```json
{
    "$comment": "SOA package linking configuration for nimbee",
    "soaPath": "../soa",
    "packages": {
        "@saga-ed/soa-api-core": "packages/node/api-core",
        "@saga-ed/soa-api-util": "packages/node/api-util",
        "@saga-ed/soa-config": "packages/core/config",
        "@saga-ed/soa-db": "packages/node/db",
        "@saga-ed/soa-logger": "packages/node/logger"
    }
}
```

**Note — path corrections**: The legacy `pnpm.overridesLocal` used flat paths (`../soa/packages/api-core`) which are incorrect for the current SOA monorepo structure. The `soa-link.json` config uses correct tiered paths (`packages/node/api-core`, `packages/core/config`). SOA's `cross-repo-link.sh` constructs full `link:` paths from `soaPath` + package path.

### 4.5 Update `soa:link` npm scripts

**File**: `/home/skelly/dev/nimbee/package.json`

```json
// Before — points to legacy nimbee script
"soa:link": "./scripts/soa-link.sh",
"soa:link:on": "./scripts/soa-link.sh on",
"soa:link:off": "./scripts/soa-link.sh off",
"soa:link:status": "./scripts/soa-link.sh status",

// After — delegates to SOA's canonical script (same as coach & thrive)
"soa:link": "../soa/scripts/cross-repo-link.sh",
"soa:link:on": "../soa/scripts/cross-repo-link.sh on",
"soa:link:off": "../soa/scripts/cross-repo-link.sh off",
"soa:link:status": "../soa/scripts/cross-repo-link.sh status",
```

### 4.6 Update `soa:auth` script

**File**: `/home/skelly/dev/nimbee/package.json`

```json
// Before (referencing saga_soa)
"soa:auth": "bash -c 'export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token --domain saga --domain-owner 531314149529 --query authorizationToken --output text) && npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_soa/:_authToken=$CODEARTIFACT_AUTH_TOKEN'"

// After (referencing saga_js)
"soa:auth": "bash -c 'export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token --domain saga --domain-owner 531314149529 --query authorizationToken --output text) && npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN'"
```

### 4.7 Remove `pnpm.overridesLocal` from `package.json`

**File**: `/home/skelly/dev/nimbee/package.json`

The `overridesLocal` field and its comment are a legacy mechanism. SOA's `cross-repo-link.sh` reads package paths from `soa-link.json` and manages `pnpm.overrides` directly. Remove:

```json
// DELETE these fields from pnpm section:
"//overridesLocal": "Run 'pnpm soa:link' to toggle local SOA packages on/off",
"overridesLocal": {
    "@saga-ed/soa-api-core": "link:../soa/packages/api-core",
    "@saga-ed/soa-api-util": "link:../soa/packages/api-util",
    "@saga-ed/soa-logger": "link:../soa/packages/logger",
    "@saga-ed/soa-config": "link:../soa/packages/config",
    "@saga-ed/soa-db": "link:../soa/packages/db"
}
```

### 4.8 Retire legacy linking scripts

**Files to delete** (replaced by SOA's `cross-repo-link.sh` + `soa-link.json`):

| File | Reason |
|------|--------|
| `scripts/soa-link.sh` | Replaced by `../soa/scripts/cross-repo-link.sh` |
| `scripts/soa-link-quickstart.md` | Replace with reference to SOA linking docs |
| `scripts/test-soa-link-builds.sh` | Rewrite or adapt for new approach if needed |

**Files to keep (optional)**:

| File | Reason |
|------|--------|
| `scripts/check-soa-links.sh` | Pre-commit hook still works — it checks `pnpm.overrides` for `link:` entries, which is the same mechanism used by `cross-repo-link.sh`. Can keep as a safety net or remove if coach/thrive don't use one. |

### 4.9 Update CI workflow: `saga-api-build.yml`

**File**: `/home/skelly/dev/nimbee/.github/workflows/saga-api-build.yml`

Replace all `saga_soa` and `saga_nimbee` references with `saga_js` in CodeArtifact login and auth token commands.

### 4.10 Scan for other `.npmrc` files

Run `find /home/skelly/dev/nimbee -name '.npmrc' -not -path '*/node_modules/*'` and update any remaining references.

---

## Phase 5: Verification

### 5.1 SOA — Publish test

```bash
cd /home/skelly/dev/soa
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js --region us-west-2
pnpm build
# Dry-run publish to verify registry target
pnpm -r --filter '@saga-ed/*' exec npm publish --dry-run
```

### 5.2 Nimbee — Publish ars_lib

```bash
cd /home/skelly/dev/nimbee/edu/js/lib/ars_lib
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js --region us-west-2
npm publish --dry-run
```

### 5.3 Coach — link:off resolution

```bash
cd /home/skelly/dev/coach
pnpm soa:link:off
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js --region us-west-2
pnpm install
pnpm build
```

### 5.4 Thrive — link:off resolution

```bash
cd /home/skelly/dev/thrive
pnpm soa:link:off
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js --region us-west-2
pnpm install
pnpm build
```

### 5.5 Nimbee — saga_api resolution (link:off)

```bash
cd /home/skelly/dev/nimbee
pnpm soa:link:off
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js --region us-west-2
pnpm install
# Verify both @saga-ed/* and @nimbee/* resolve from saga_js
pnpm ls @saga-ed/soa-logger @nimbee/ars-lib
```

### 5.6 Nimbee — cross-repo-link.sh (link:on)

```bash
cd /home/skelly/dev/nimbee
pnpm soa:link:on
# Verify overrides are set with correct tiered paths
pnpm soa:link:status
# Build to confirm local packages resolve
pnpm install
# Verify link paths use correct monorepo structure
cat package.json | jq '.pnpm.overrides'
# Expected: "@saga-ed/soa-api-core": "link:../soa/packages/node/api-core" (not packages/api-core)
```

---

## Files Changed Per Repo

### SOA (`gh_t54`) — 25 files ✅ COMPLETE
| File | Action | Status |
|------|--------|--------|
| `.npmrc` | Update registry URL saga_soa → saga_js | ✅ |
| `package.json` (root) | Update co:login, co:whoami scripts | ✅ |
| `packages/node/api-core/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/api-util/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/aws-util/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `packages/node/db/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/logger/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/pubsub-client/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/pubsub-core/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/pubsub-server/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `packages/node/rabbitmq/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/redis-core/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/node/test-util/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `packages/core/config/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/core/trpc-codegen/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/core/tgql-codegen/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `packages/core/typescript-config/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `packages/core/eslint-config/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `packages/web/ui/package.json` | Migrate publishConfig GitHub Packages → saga_js | ✅ |
| `build-tools/zod2ts/package.json` | Update publishConfig saga_soa → saga_js | ✅ |
| `.github/workflows/publish-codeartifact.yml` | replace_all saga_soa → saga_js | ✅ |
| `docs/CODEARTIFACT_SETUP.md` | replace_all saga_soa → saga_js | ✅ |
| `docs/cicd-package-publishing.md` | Rewrite for CodeArtifact (was GitHub Packages) | ✅ |
| `docs/quickstart.md` | Update registry reference to CodeArtifact | ✅ |
| `docs/github-packages-migration.md` | Add deprecation notice | ✅ |
| `docs/manual-package-management.md` | Add deprecation notice | ✅ |
| `.github/workflows/publish-all-packages.yml` | No changes needed (no saga_soa refs) | — |
| `docs/cross-repo-linking-summary.md` | No changes needed (no saga_soa refs) | — |

### Coach (`gh_t54`) — 1 file ✅ COMPLETE
| File | Action | Status |
|------|--------|--------|
| `.npmrc` | Create (new file) — `@saga-ed` → saga_js, `always-auth=true` | ✅ |
| CI workflows | No `.github/workflows/` directory exists — nothing to update | — |
| `soa-link.json` | Already exists with correct tiered paths | — |
| `package.json` scripts | Already delegates to `../soa/scripts/cross-repo-link.sh` | — |

### Thrive (`gh_t54`) — 1 file ✅ COMPLETE
| File | Action | Status |
|------|--------|--------|
| `.npmrc` | Create (new file) — `@saga-ed` → saga_js, `always-auth=true` | ✅ |
| CI workflows | `claude-code-review.yml`, `claude.yml` — Claude actions only, no CodeArtifact refs | — |
| `soa-link.json` | Already exists with correct tiered paths (5 packages) | — |
| `package.json` scripts | Already delegates to `../soa/scripts/cross-repo-link.sh` | — |
| `scripts/switch-saga-soa-deps.sh` | Legacy script (unreferenced, has GitHub Packages refs) — not modified, candidate for removal | — |

### Nimbee (`gh_7763`) — 14 files ✅ COMPLETE
| File | Action | Status |
|------|--------|--------|
| `.npmrc` (root) | Rewrite: add `@nimbee` scope, both → `saga_js`, add `always-auth` | ✅ |
| `edu/js/lib/ars_lib/.npmrc` | Update `@nimbee` scope saga_nimbee → saga_js | ✅ |
| `edu/js/app/saga_api/.npmrc` | Rewrite: both scopes → saga_js | ✅ |
| `soa-link.json` | **Created** (5 packages with correct tiered paths) | ✅ |
| `package.json` | Update `soa:link*` → `../soa/scripts/cross-repo-link.sh` | ✅ |
| `package.json` | Update `soa:auth` script saga_soa → saga_js | ✅ |
| `package.json` | Remove `pnpm.overridesLocal` + `//overridesLocal` | ✅ |
| `scripts/soa-link.sh` | **Deleted** | ✅ |
| `scripts/soa-link-quickstart.md` | **Deleted** | ✅ |
| `scripts/test-soa-link-builds.sh` | **Deleted** | ✅ |
| `.github/workflows/saga-api-test.yml` | replace_all saga_soa → saga_js (2 occurrences) | ✅ |
| `.github/workflows/saga-api-image.yaml` | replace_all saga_soa → saga_js (4 occurrences) | ✅ |
| `edu/js/app/saga_api/docker/Dockerfile.nx` | replace_all saga_soa → saga_js | ✅ |
| `edu/js/app/saga_api/docker/Dockerfile` | replace_all saga_soa → saga_js | ✅ |
| `edu/js/app/saga_api/scripts/co-login.sh` | Simplified: single saga_js registry (was loop over 3 repos) | ✅ |
| `edu/js/app/saga_api/docs/SOA_PACKAGES.md` | replace_all saga_soa → saga_js (12 occurrences) | ✅ |
| `build_tools/build_js_apis.rb` | replace_all saga_nimbee → saga_js | ✅ |
| `scripts/check-soa-links.sh` | Kept (pre-commit hook, still compatible) | — |

---

## Rollback Plan

If issues arise, revert `.npmrc` and `publishConfig` changes in each repo. The old repositories (`saga_soa`, `saga_nimbee`) remain intact and can serve packages until migration is confirmed.

---

## Cross-Repo Linking Alignment

After this plan is complete, all three consuming repos will use the same linking pattern:

| Repo | Config File | Script | Packages Linked |
|------|-------------|--------|-----------------|
| **Coach** | `soa-link.json` | `../soa/scripts/cross-repo-link.sh` | 4: api-core, config, db, logger |
| **Thrive** | `soa-link.json` | `../soa/scripts/cross-repo-link.sh` | 5: api-core, config, db, logger, rabbitmq |
| **Nimbee** | `soa-link.json` | `../soa/scripts/cross-repo-link.sh` | 5: api-core, api-util, config, db, logger |

**SOA owns the linking script**. Each consuming repo owns only its `soa-link.json` config declaring which packages it uses. Commands are identical across all repos:

```bash
pnpm soa:link:on      # Enable local SOA linking
pnpm soa:link:off     # Disable — use CodeArtifact registry
pnpm soa:link:status  # Check current state
```

**Legacy path correction**: Nimbee's old `overridesLocal` used flat paths like `link:../soa/packages/api-core`. The SOA monorepo uses tiered paths (`packages/node/api-core`, `packages/core/config`). The new `soa-link.json` config uses correct paths, and `cross-repo-link.sh` constructs the full `link:` protocol paths automatically.

---

## Resolved Questions

### 1. `saga_js` npmjs upstream — YES

Configure `npmjs` as an upstream of `saga_js` so public npm packages resolve through CodeArtifact. This is verified in Phase 0.

### 2. GitHub Packages → `saga_js` — YES

6 packages currently publish to `npm.pkg.github.com`:

| Package | Location | External Consumers |
|---------|----------|--------------------|
| `@saga-ed/soa-typescript-config` | `packages/core/typescript-config` | None (`workspace:*`) |
| `@saga-ed/soa-eslint-config` | `packages/core/eslint-config` | None (`workspace:*`) |
| `@saga-ed/soa-ui` | `packages/web/ui` | None (`workspace:*`) |
| `@saga-ed/soa-test-util` | `packages/node/test-util` | None (`workspace:*`) |
| `@saga-ed/soa-aws-util` | `packages/node/aws-util` | None (`workspace:*`) |
| `@saga-ed/soa-pubsub-server` | `packages/node/pubsub-server` | None (`workspace:*`/`^`) |

None are consumed outside SOA today (all resolved via pnpm workspace protocol). Migrate their `publishConfig` to `saga_js` for registry consolidation. Add these 6 to Phase 1.2 package list.

### 3. Bump package versions — YES

Bump versions during migration to clearly delineate pre/post-migration artifacts in `saga_js`.

### 4. IAM permissions — TBD

Verify whether `SOADeployRole` needs policy updates for `saga_js`. Check during Phase 0.

### 5. Pre-commit hook standardization — Hybrid approach (Option C)

SOA provides `scripts/check-soa-links.sh` alongside `cross-repo-link.sh`. Each consuming repo references it in its own `.pre-commit-config.yaml`:

```yaml
- repo: local
  hooks:
    - id: check-soa-links
      entry: ../soa/scripts/check-soa-links.sh
      language: script
      files: ^package\.json$
```

**Rationale**: Consistent with the existing pattern where SOA owns the scripts and consuming repos delegate to them. Avoids complex `init` logic (which would need to detect hook framework, only runs once so doesn't auto-update). Each repo still needs a one-line config entry, but the actual logic lives in SOA and stays in sync automatically.

**Action items**:
- Move nimbee's `check-soa-links.sh` logic into SOA at `scripts/check-soa-links.sh`
- Update nimbee's `.pre-commit-config.yaml` to point to `../soa/scripts/check-soa-links.sh`
- Add `.pre-commit-config.yaml` entries to coach and thrive
