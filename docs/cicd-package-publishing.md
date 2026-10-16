# CI/CD Package Publishing Guide

This document describes how to use the automated CI/CD pipeline for publishing `@saga-ed` packages to AWS CodeArtifact.

## Overview

Two workflows split the job:

- **`package-ci.yml`** (pull requests): lint, type check and test every package in dependency-layer order. Never publishes.
- **`publish-codeartifact.yml`** (manual dispatch): publishes ONE package at the version already committed in its `package.json`. Packages do not publish automatically on merge.

## Publishing a Package

1. Bump the package's `version` in the PR and merge it.
2. Dispatch the publish workflow from `main`:

```bash
gh workflow run publish-codeartifact.yml -R saga-ed/soa --ref main \
  -f single_package=packages/<runtime>/<pkg>
```

3. If the package has `workspace:` runtime dependencies (`dependencies`, `peerDependencies`, `optionalDependencies`), publish those first. The workflow's `preflight` job checks that each dependency's exact local version exists in CodeArtifact and fails with the list of missing ones; publishing is gated on it.

Options:
- `-f dry_run=true`: build, test and preflight only, no publish.
- `-f skip_tests=true`: skip the test job (preflight still runs).
- `-f publish_target=codeartifact|github|both` (default `codeartifact`).
- Branch prerelease: commit a `-dev.N` version on the branch and dispatch with `--ref <branch>`.

## Package Publishing Rules

### What Gets Published
- ✅ The single `single_package` target, if non-private, at its committed version
- ⏭️ A version that already exists in the registry is skipped, not failed

### What Gets Blocked
- ❌ **Private packages** (`"private": true`)
- ❌ **Failed tests** (unless `skip_tests=true`)
- ❌ **Failed preflight** (a `workspace:` runtime dependency's version is not in CodeArtifact)

### Publishing Order
The operator publishes dependencies before dependents; `preflight` enforces it.

## PR CI Matrix

`package-ci.yml` runs one matrix job per package within each dependency layer:

```yaml
strategy:
  fail-fast: false  # Continue testing other packages if one fails
  matrix:
    package: ${{ fromJson(needs.detect-changes.outputs.changed-packages) }}
```

## Package Scope Configuration

All packages are published under the `@saga-ed` scope to AWS CodeArtifact:

```json
{
  "name": "@saga-ed/package-name",
  "publishConfig": {
    "registry": "https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/",
    "access": "public"
  }
}
```

## Installing Published Packages

### Configure .npmrc for CodeArtifact

Add to your project's `.npmrc`:

```npmrc
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

### Authenticate with CodeArtifact

```bash
# Easiest: run co:login from any repo that has it
pnpm co:login

# Or manually (valid 12 hours):
export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
  --domain saga \
  --domain-owner 531314149529 \
  --query authorizationToken \
  --output text)
npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN
```

> **Note:** Do NOT use `aws codeartifact login --tool npm` — it hijacks the default registry in `~/.npmrc`. See [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md#troubleshooting) for details.

### Install packages
```bash
# Install specific packages using pnpm
pnpm add @saga-ed/soa-api-core
pnpm add @saga-ed/soa-config
pnpm add @saga-ed/soa-db
pnpm add @saga-ed/soa-logger
```

## Monitoring and Debugging

### Check Workflow Status
```bash
# List recent workflow runs
gh run list --workflow="Publish to CodeArtifact"

# View specific run details
gh run view <run-id>

# View logs for specific run
gh run view <run-id> --log
```

### Check Published Packages
```bash
# List packages in CodeArtifact
aws codeartifact list-packages \
  --domain saga \
  --domain-owner 531314149529 \
  --repository saga_js

# View specific package versions
aws codeartifact list-package-versions \
  --domain saga \
  --repository saga_js \
  --format npm \
  --package soa-logger \
  --namespace saga-ed
```

### Common Issues

#### 1. "Package already exists"
This is normal - the workflow will skip republishing if the version already exists.

#### 2. "401 Unauthorized"
Auth token may have expired (12-hour TTL). Re-authenticate:
```bash
pnpm co:login
```

#### 3. "depends on unpublished <dep>@<version>"
The preflight job found a `workspace:` runtime dependency whose version is not in CodeArtifact. Publish it first with `single_package=<its path>` (the error names the path), then re-dispatch.

## Best Practices

### 1. Semantic Versioning
- **patch**: Bug fixes, small changes
- **minor**: New features, backward compatible
- **major**: Breaking changes

### 2. Branch Strategy
- ✅ **Main branch**: Production releases
- ✅ **Feature branches**: Development versions  
- ❌ Avoid publishing from unstable branches

### 3. Testing
- All packages must pass lint, type checking, and tests
- Use the matrix jobs to catch issues early
- Failed tests block publication

### 4. Documentation
- Update package READMEs when making changes
- Document breaking changes in commit messages
- Use conventional commits for better changelog generation

## Workflow Configuration

The publish workflow is `.github/workflows/publish-codeartifact.yml`:

- **Resolve Version**: validates `single_package` and reads its committed version
- **Test Package**: lint, type check, test (skippable)
- **Dependency Preflight**: verifies `workspace:` runtime deps exist in CodeArtifact (runs on dry runs too)
- **Publish**: CodeArtifact and/or GitHub Packages, OIDC authentication via SOADeployRole
- **Release Summary**: what was published

For more details, see the workflow file itself.

## See also

- [CODEARTIFACT_SETUP.md](./CODEARTIFACT_SETUP.md) — registry setup, IAM permissions, consuming packages
- [package-registry-quickstart.md](./package-registry-quickstart.md) — cross-repo publish/link/resolve workflow
