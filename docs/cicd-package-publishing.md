# CI/CD Package Publishing Guide

This document describes how to use the automated CI/CD pipeline for publishing `@saga-ed` packages to AWS CodeArtifact.

## Overview

The CI/CD pipeline automatically:
- 🔍 Detects which packages have changed using Turborepo
- 🧪 Runs lint, type checking, and tests only on affected packages
- 📦 Builds packages in dependency order
- 🚀 Publishes only changed packages to AWS CodeArtifact under the `@saga-ed` scope
- 📊 Uses matrix jobs for parallel processing

## Triggering the Pipeline

### 1. Manual Triggers with Version Bumps

Use the GitHub CLI to trigger manual deployments with version bumps:

#### Patch Version Bump (1.0.0 → 1.0.1)
```bash
gh workflow run "Publish to CodeArtifact" \
  --field version=patch
```

#### Minor Version Bump (1.0.0 → 1.1.0)
```bash
gh workflow run "Publish to CodeArtifact" \
  --field version=minor
```

#### Major Version Bump (1.0.0 → 2.0.0)
```bash
gh workflow run "Publish to CodeArtifact" \
  --field version=major
```

#### Force Publish All Packages (ignore change detection)
```bash
gh workflow run "Publish to CodeArtifact" \
  --field version=patch \
  --field force_publish_all=true
```

## How Change Detection Works

The pipeline uses **Turborepo** to intelligently detect changes:

### 1. For Push Events
```bash
# Compares current commit with previous commit
pnpm turbo run build --dry=json --filter="...[${GITHUB_EVENT_BEFORE}]"
```

### 2. For Manual Triggers
```bash
# Compares with last git tag or main branch
pnpm turbo run build --dry=json --filter="...[${LAST_TAG}]"
```

### 3. Dependency Aware
If package A depends on package B, and B changes, then A will also be rebuilt and potentially republished.

## Package Publishing Rules

### What Gets Published
- ✅ **Non-private packages** only (`"private": false` or not set)
- ✅ **Changed packages** (detected by Turborepo)
- ✅ **Packages with updated dependencies** (dependency cascade)

### What Gets Skipped
- ❌ **Private packages** (`"private": true`)
- ❌ **Unchanged packages** (no code changes)
- ❌ **Failed tests** (entire workflow fails)

### Publishing Order
Packages are published in **dependency order** to ensure:
1. Base packages (no internal deps) publish first
2. Dependent packages publish after their dependencies
3. No circular dependency issues

## Matrix Job Strategy

The pipeline uses GitHub Actions matrix strategy:

```yaml
strategy:
  fail-fast: false  # Continue testing other packages if one fails
  matrix:
    package: ${{ fromJson(needs.detect-changes.outputs.changed-packages) }}
```

This means:
- 🚀 **Parallel execution** for lint/test of different packages
- 🛡️ **Isolation** - one package failure doesn't stop others
- ⚡ **Faster feedback** - get results for working packages immediately

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

#### 3. "No changes detected"
If you expect changes but none are detected:
- Check if files are in the `packages/` directory
- Verify Turborepo configuration in `turbo.json`
- Use `force_publish_all=true` to override change detection

#### 4. "Dependency order issues"
The workflow automatically handles dependency order using Turborepo's task graph.

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

The workflow is defined in `.github/workflows/publish-codeartifact.yml` and includes:

- **Change Detection**: Uses Turborepo to find affected packages
- **Matrix Testing**: Parallel lint/test execution per package
- **Dependency-Aware Building**: Builds packages in correct order
- **Smart Publishing**: Only publishes changed, non-private packages
- **CodeArtifact Integration**: OIDC authentication via SOADeployRole
- **Release Summaries**: Detailed output of what was published

For more details, see the workflow file itself.
