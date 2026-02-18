# Package Registry Quickstart

How `@saga-ed` and `@nimbee` packages are published, resolved, and linked across repos. Covers CodeArtifact authentication, `.npmrc` registry configuration, the `cross-repo-link.sh` on/off toggle for local development, publishing individual packages or the full SOA suite via CI, and the per-repo `soa-link.json` setup.

All `@saga-ed/*` packages live in a single AWS CodeArtifact repository: **saga_js**.

## Authenticate

Tokens last 12 hours. Re-run when you get 401s.

```bash
# From any repo with co:login configured:
pnpm co:login

# Or manually:
export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
  --domain saga --domain-owner 531314149529 \
  --query authorizationToken --output text)
npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken="$CODEARTIFACT_AUTH_TOKEN"
```

> **Warning:** Do NOT use `aws codeartifact login --tool npm`. It sets the **default registry** in `~/.npmrc` to CodeArtifact, which breaks `pnpm install` for any public npm package. Always use scoped `_authToken` entries instead (as shown above).

## How Packages Resolve

Each consuming repo has an `.npmrc` that points `@saga-ed` at CodeArtifact:

```ini
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

Nimbee also routes `@nimbee` to the same registry. That's the only difference.

When you run `pnpm install` with no overrides, packages come from the registry. When linking is enabled, pnpm overrides redirect them to your local filesystem instead.

## Local Linking (link on/off)

Toggle between local SOA source and published packages:

```bash
# From any consuming repo (coach, thrive, nimbee):
../soa/scripts/cross-repo-link.sh on       # use local soa packages
../soa/scripts/cross-repo-link.sh off      # use registry packages
../soa/scripts/cross-repo-link.sh status   # check current state
```

The script reads `soa-link.json` in your repo root, writes pnpm overrides to `package.json`, and runs `pnpm install`. Always run `off` before committing.

### What Each Repo Links

| Repo | Packages |
|------|----------|
| **coach** | api-core, config, db, logger |
| **thrive** | api-core, config, db, logger, rabbitmq |
| **nimbee** | api-core, api-util, config, db, logger |

To change which packages get linked, edit `soa-link.json`:

```json
{
    "soaPath": "../soa",
    "packages": {
        "@saga-ed/soa-logger": "packages/node/logger",
        "@saga-ed/soa-config": "packages/core/config"
    }
}
```

Package paths follow the SOA monorepo layout: `packages/node/*` or `packages/core/*`.

## Publishing

### Single package (from the package directory)

```bash
cd packages/node/logger    # or any package with a publishConfig
pnpm publish --no-git-checks --access public
```

This works for any package whose `.npmrc` or `publishConfig` points at `saga_js` — including non-SOA packages like `@nimbee/ars-lib` in the nimbee repo.

### All SOA packages (CI workflow)

The GitHub Actions workflow builds, tests, and publishes every SOA package in dependency order:

```bash
gh workflow run publish-codeartifact.yml -f version=patch
```

Add `-f dry_run=true` to build and test without actually publishing.

After publishing, consuming repos pick up new versions on their next `pnpm install` (with linking off).

## Preinstall Hooks

Each consuming repo has a `preinstall` script that auto-authenticates before `pnpm install`:

```json
{
  "scripts": {
    "preinstall": "npm run co:login || true",
    "co:login": "export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token --domain saga --domain-owner 531314149529 --query authorizationToken --output text) && npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN && echo 'CodeArtifact auth token configured'"
  }
}
```

Design notes:
- **`|| true`** makes the hook non-fatal — CI handles its own auth, and offline devs get a clear 401 later rather than a cryptic preinstall crash.
- **`npm run`** instead of `pnpm run` — during preinstall, pnpm may not have resolved its own binary yet. `npm` is always available system-wide.
- **`morning-auth.sh`** still runs `get-authorization-token` centrally for ergonomics. The preinstall hooks are a safety net, not a replacement.

Repos with preinstall hooks: **soa**, **thrive**, **coach**, **nimbee/saga_api**, **nimbee/adm_api**.

## Repo Setup Checklist

To add CodeArtifact support to a new consuming repo:

1. Create `.npmrc` with the `@saga-ed` registry line above
2. Add `preinstall` and `co:login` scripts to `package.json` (see above)
3. Create `soa-link.json` mapping the packages you use
4. Use `^x.y.z` version ranges (not `workspace:*`) for `@saga-ed` deps in `package.json`
5. Run `../soa/scripts/cross-repo-link.sh on` to start developing locally

## Further Reading

- [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md) — full registry setup, IAM permissions, CI/CD config
- [cross-repo-linking-summary.md](./cross-repo-linking-summary.md) — detailed linking workflow and troubleshooting
