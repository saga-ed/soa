# CodeArtifact & Cross-Repo Linking Quickstart

All `@saga-ed/*` packages live in a single AWS CodeArtifact repository: **saga_js**.

## Authenticate

Tokens last 12 hours. Re-run when you get 401s.

```bash
aws codeartifact login --tool npm --domain saga --domain-owner 531314149529 --repository saga_js
```

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

Packages are published from SOA via GitHub Actions:

```bash
gh workflow run publish-codeartifact.yml -f version=patch
```

Or with options:

```bash
gh workflow run publish-codeartifact.yml \
  -f version=minor \
  -f dry_run=true         # build and test only, don't publish
```

The workflow builds, tests, and publishes in dependency order. After publishing, consuming repos pick up new versions on their next `pnpm install` (with linking off).

## Repo Setup Checklist

To add CodeArtifact support to a new consuming repo:

1. Create `.npmrc` with the `@saga-ed` registry line above
2. Create `soa-link.json` mapping the packages you use
3. Use `^x.y.z` version ranges (not `workspace:*`) for `@saga-ed` deps in `package.json`
4. Run `../soa/scripts/cross-repo-link.sh on` to start developing locally

## Further Reading

- [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md) — full registry setup, IAM permissions, CI/CD config
- [cross-repo-linking-summary.md](./cross-repo-linking-summary.md) — detailed linking workflow and troubleshooting
