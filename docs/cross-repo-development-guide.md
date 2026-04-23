# Cross-Repo Development with pnpm Workspaces

Best practices for developing across soa and its consuming monorepos (thrive, coach).

## The Core Problem

Our architecture has a shared foundation repo (`soa`) that publishes `@saga-ed/soa-*` packages to AWS CodeArtifact. Consuming repos (`thrive`, `coach`) pull these packages from the registry. When you need to change a soa package and test it in a consumer *simultaneously*, the publish-install cycle is too slow.

pnpm's `overrides` feature solves this by redirecting package resolution from the registry to a local filesystem path using the `link:` protocol.

## The Critical Rule

**Overrides MUST be declared in the root `package.json` of the consuming monorepo.**

```
thrive/
  package.json          <-- overrides go HERE
  apps/
    node/
      sessions-api/
        package.json    <-- NOT here
```

pnpm only reads `pnpm.overrides` from the **workspace root** `package.json`. Putting overrides in a nested `package.json` (e.g., `apps/node/sessions-api/package.json`) has no effect. pnpm silently ignores them. This is the single most common mistake when setting up cross-repo linking.

### Why Root-Level Only?

pnpm workspaces have a single resolution context anchored at the workspace root. The `pnpm.overrides` field acts as a global resolution directive — it tells pnpm "whenever *any* package in this workspace asks for `@saga-ed/soa-logger`, resolve it to this path instead." Nested `package.json` files define what a package *needs*, but only the root controls *how* those needs are resolved.

## How It Works

### Directory Layout

```
~/dev/
  soa/                              # Source of @saga-ed/soa-* packages
    packages/
      node/
        api-core/                   # @saga-ed/soa-api-core
        db/                         # @saga-ed/soa-db
        logger/                     # @saga-ed/soa-logger
        rabbitmq/                   # @saga-ed/soa-rabbitmq
      core/
        config/                     # @saga-ed/soa-config
    scripts/
      cross-repo-link.sh           # The linking tool

  thrive/                           # Consumer repo
    package.json                    # Root — overrides go here
    soa-link.json                   # Declares which soa packages to link
    apps/node/sessions-api/         # Uses @saga-ed/soa-db, soa-logger, etc.

  coach/                            # Consumer repo
    package.json                    # Root — overrides go here
    soa-link.json                   # Declares which soa packages to link
    apps/node/coach-api/            # Uses @saga-ed/soa-api-core, soa-db, etc.
```

### The Override Mechanism

When linking is **off** (default, committed state):

```jsonc
// thrive/package.json
{
  "pnpm": {
    "overrides": {
      "zod": "^3.24.0"            // Only non-soa overrides
    }
  }
}
```

All `@saga-ed/soa-*` packages resolve from AWS CodeArtifact per `.npmrc`:
```
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

When linking is **on** (local development only):

```jsonc
// thrive/package.json (modified by cross-repo-link.sh)
{
  "pnpm": {
    "overrides": {
      "zod": "^3.24.0",
      "@saga-ed/soa-api-core": "link:../soa/packages/node/api-core",
      "@saga-ed/soa-config": "link:../soa/packages/core/config",
      "@saga-ed/soa-db": "link:../soa/packages/node/db",
      "@saga-ed/soa-logger": "link:../soa/packages/node/logger",
      "@saga-ed/soa-rabbitmq": "link:../soa/packages/node/rabbitmq"
    }
  }
}
```

The `link:` protocol creates symlinks in `node_modules` pointing to the soa source directories. Changes to soa package source files are immediately available in the consumer — but the soa package must be **built** (`pnpm build` in soa) for its `dist/` output to reflect source changes.

## Tooling

### `cross-repo-link.sh`

The `soa/scripts/cross-repo-link.sh` script automates the override toggle. It lives in soa and is called from consuming repos.

#### Setup

Each consuming repo needs two things:

**1. `soa-link.json`** — declares which packages to link:

```jsonc
// thrive/soa-link.json
{
  "soaPath": "../soa",
  "packages": {
    "@saga-ed/soa-api-core": "packages/node/api-core",
    "@saga-ed/soa-config": "packages/core/config",
    "@saga-ed/soa-db": "packages/node/db",
    "@saga-ed/soa-logger": "packages/node/logger",
    "@saga-ed/soa-rabbitmq": "packages/node/rabbitmq"
  }
}
```

Only list the packages your repo actually uses. Run `init` to generate a default with all 11 available packages, then trim it:

```bash
../soa/scripts/cross-repo-link.sh init
```

**2. npm scripts** — convenience wrappers in root `package.json`:

```json
{
  "scripts": {
    "soa:link:on": "../soa/scripts/cross-repo-link.sh on",
    "soa:link:off": "../soa/scripts/cross-repo-link.sh off",
    "soa:link:status": "../soa/scripts/cross-repo-link.sh status"
  }
}
```

#### Commands

| Command | Effect |
|---------|--------|
| `pnpm soa:link:on` | Injects `link:` overrides into root `package.json`, runs `pnpm install` |
| `pnpm soa:link:off` | Removes `link:` overrides, runs `pnpm install` |
| `pnpm soa:link:status` | Reports current state and lists linked packages |

### Current Package Inventories

**Thrive** links 5 packages:

| Package | SOA Path |
|---------|----------|
| `@saga-ed/soa-api-core` | `packages/node/api-core` |
| `@saga-ed/soa-config` | `packages/core/config` |
| `@saga-ed/soa-db` | `packages/node/db` |
| `@saga-ed/soa-logger` | `packages/node/logger` |
| `@saga-ed/soa-rabbitmq` | `packages/node/rabbitmq` |

**Coach** links 5 packages:

| Package | SOA Path |
|---------|----------|
| `@saga-ed/soa-api-core` | `packages/node/api-core` |
| `@saga-ed/soa-aws-util` | `packages/node/aws-util` |
| `@saga-ed/soa-config` | `packages/core/config` |
| `@saga-ed/soa-db` | `packages/node/db` |
| `@saga-ed/soa-logger` | `packages/node/logger` |

## Safety Guards

Accidentally committing `link:` overrides breaks CI and other developers' environments. We have three layers of protection:

### 1. Claude Code Hook (thrive)

A `PreToolUse` hook in `.claude/hooks/check-soa-link.sh` blocks `git push` when `link:` overrides are detected in `package.json` — either in the working tree or the committed HEAD.

### 2. CI Check (coach)

`scripts/ensure-no-soa-links.js` runs in the deploy workflow and fails the build if:
- `pnpm.overrides` contains any `link:` references
- Root `dependencies`/`devDependencies` have `@saga-ed` packages with `link:` references
- Any `@saga-ed/soa-*` package used in the repo is not listed in `overrides` or `overridesLocal` (coverage check)

### 3. The `overridesLocal` Pattern (coach)

Coach uses a custom `pnpm.overridesLocal` field as a metadata registry:

```jsonc
// coach/package.json
{
  "pnpm": {
    "overrides": {},                         // Empty when not linked
    "overridesLocal": {                      // NOT a pnpm feature — metadata only
      "@saga-ed/soa-api-core": "link:../soa/packages/node/api-core",
      "@saga-ed/soa-aws-util": "link:../soa/packages/node/aws-util",
      "@saga-ed/soa-config": "link:../soa/packages/core/config",
      "@saga-ed/soa-db": "link:../soa/packages/node/db",
      "@saga-ed/soa-logger": "link:../soa/packages/node/logger"
    }
  }
}
```

pnpm ignores `overridesLocal` entirely — it's a convention the CI script reads to validate that all consumed `@saga-ed/soa-*` packages are accounted for. This catches cases where someone adds a new soa dependency to a nested `package.json` without updating the link config.

## Development Workflow

### Cross-Repo Feature Development

```bash
# 1. Start in soa — make your changes
cd ~/dev/soa
# edit packages/node/logger/src/index.ts
pnpm build                          # Build so dist/ is current

# 2. Switch to consumer — enable linking
cd ~/dev/thrive
pnpm soa:link:on                    # Injects overrides, runs pnpm install

# 3. Develop and test
pnpm test                           # Tests use local soa-logger
pnpm dev                            # Dev server uses local soa-logger

# 4. Iterate: edit soa source -> rebuild soa -> changes appear in thrive
cd ~/dev/soa
# edit more files...
pnpm build                          # Rebuild — thrive picks up changes immediately

# 5. Before committing thrive changes
cd ~/dev/thrive
pnpm soa:link:off                   # Remove overrides, back to registry
pnpm soa:link:status                # Verify: should say "REGISTRY"
git add . && git commit             # Safe to commit

# 6. Publish soa changes separately
cd ~/dev/soa
# Follow soa's publishing workflow to push new package versions to CodeArtifact
```

### Quick Check: Am I Linked?

```bash
pnpm soa:link:status
# Output when linked:
#   SOA packages: LINKED (local)
#   Source: /home/skelly/dev/thrive/../soa/packages/*
#   Linked packages:
#     @saga-ed/soa-logger -> packages/node/logger
#     ...

# Output when not linked:
#   SOA packages: REGISTRY
```

## Common Pitfalls

### 1. Overrides in the Wrong `package.json`

**Symptom**: You added overrides but the consumer still uses the registry version.

**Cause**: Overrides were placed in a nested `package.json` instead of the workspace root.

**Fix**: Move overrides to the root `package.json`. Or better, use `pnpm soa:link:on`.

### 2. Stale Builds

**Symptom**: Changes in soa source don't appear in the consumer.

**Cause**: The `link:` protocol points to the soa package directory, but the consumer imports from `dist/`. If soa hasn't been rebuilt, `dist/` is stale.

**Fix**: Run `pnpm build` in soa after making changes. For faster iteration on a specific package:
```bash
cd ~/dev/soa
pnpm --filter @saga-ed/soa-logger build
```

### 3. Missing Packages in `soa-link.json`

**Symptom**: Most soa packages are linked but one still comes from the registry.

**Cause**: The package isn't listed in `soa-link.json`.

**Example**: Thrive's `jobs-api` depends on `@saga-ed/soa-api-util` but `soa-link.json` doesn't include it — so it resolves from the registry even when linking is on.

**Fix**: Add the missing package to `soa-link.json` and re-run `pnpm soa:link:on`.

### 4. Committed Link Overrides

**Symptom**: CI fails, other developers get resolution errors.

**Cause**: `link:` overrides were committed to `package.json`.

**Fix**: Run `pnpm soa:link:off`, commit the cleaned `package.json`.

**Prevention**: The Claude Code hook and CI check catch this. For extra safety, add a git pre-push hook.

### 5. Auth Token Expired

**Symptom**: `pnpm install` fails with 401/403 for `@saga-ed` packages after turning linking off.

**Cause**: AWS CodeArtifact auth token has expired.

**Fix**: Re-authenticate:
```bash
pnpm co:login
```

### 6. `NODE_ENV=production` Skips devDependencies

**Symptom**: `pnpm install` after toggling linking doesn't install everything.

**Fix**: 
```bash
NODE_ENV=development pnpm install
```

## Adding a New Consuming Repo

To set up cross-repo linking for a new repo that depends on `@saga-ed/soa-*` packages:

1. **Clone side-by-side** with soa:
   ```
   ~/dev/
     soa/          # Must exist at ../soa relative to your repo
     your-repo/
   ```

2. **Initialize the config**:
   ```bash
   cd ~/dev/your-repo
   ../soa/scripts/cross-repo-link.sh init
   ```

3. **Trim `soa-link.json`** to only the packages your repo uses.

4. **Add npm scripts** to root `package.json`:
   ```json
   {
     "scripts": {
       "soa:link:on": "../soa/scripts/cross-repo-link.sh on",
       "soa:link:off": "../soa/scripts/cross-repo-link.sh off",
       "soa:link:status": "../soa/scripts/cross-repo-link.sh status"
     }
   }
   ```

5. **Add safety guards** — at minimum, adopt the CI check from coach:
   - Copy `coach/scripts/ensure-no-soa-links.js` to your repo
   - Add it to your CI workflow
   - Add `overridesLocal` to root `package.json` for coverage validation

## Available SOA Packages

All packages that can be linked from soa:

| Package | SOA Path | Key Dependencies |
|---------|----------|-----------------|
| `@saga-ed/soa-logger` | `packages/node/logger` | (none) |
| `@saga-ed/soa-config` | `packages/core/config` | (none) |
| `@saga-ed/soa-api-util` | `packages/node/api-util` | soa-logger |
| `@saga-ed/soa-api-core` | `packages/node/api-core` | soa-logger |
| `@saga-ed/soa-db` | `packages/node/db` | soa-config |
| `@saga-ed/soa-rabbitmq` | `packages/node/rabbitmq` | soa-logger |
| `@saga-ed/soa-aws-util` | `packages/node/aws-util` | soa-api-util, soa-logger |
| `@saga-ed/soa-test-util` | `packages/node/test-util` | soa-api-util |
| `@saga-ed/soa-redis-core` | `packages/node/redis-core` | soa-api-util, soa-logger |
| `@saga-ed/soa-pubsub-core` | `packages/node/pubsub-core` | (none) |
| `@saga-ed/soa-pubsub-server` | `packages/node/pubsub-server` | soa-pubsub-core, soa-api-core, soa-logger |
| `@saga-ed/soa-pubsub-client` | `packages/node/pubsub-client` | soa-pubsub-core, soa-pubsub-server, soa-logger |

Note the dependency chains: if you link `soa-aws-util`, you should also link `soa-api-util` and `soa-logger` for a fully local resolution chain. Otherwise, `soa-aws-util` resolves locally but its own `soa-api-util` dependency resolves from the registry, creating a mixed state.

---

*Tooling: [`soa/scripts/cross-repo-link.sh`](../scripts/cross-repo-link.sh)*
*See also: [`cross-repo-linking-summary.md`](./cross-repo-linking-summary.md) for the quick reference version*
