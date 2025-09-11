# CI/CD Package Publishing Guide

This document describes how to use the automated CI/CD pipeline for publishing `@hipponot` packages to GitHub Packages.

## Overview

The CI/CD pipeline automatically:
- 🔍 Detects which packages have changed using Turborepo
- 🧪 Runs lint, type checking, and tests only on affected packages 
- 📦 Builds packages in dependency order
- 🚀 Publishes only changed packages to GitHub Packages under the `@hipponot` scope
- 📊 Uses matrix jobs for parallel processing

## Triggering the Pipeline

### 1. Automatic Triggers

The pipeline runs automatically on:

```yaml
# Push to main branch with package changes
push:
  branches: [main]
  paths: ["packages/**", "build-tools/**", "turbo.json", "pnpm-workspace.yaml"]

# GitHub releases
release:
  types: [published]
```

### 2. Manual Triggers with Version Bumps

Use the GitHub CLI to trigger manual deployments with version bumps:

#### Patch Version Bump (1.0.0 → 1.0.1)
```bash
gh workflow run "Publish Packages to GitHub Packages" \
  --field version=patch
```

#### Minor Version Bump (1.0.0 → 1.1.0)  
```bash
gh workflow run "Publish Packages to GitHub Packages" \
  --field version=minor
```

#### Major Version Bump (1.0.0 → 2.0.0)
```bash
gh workflow run "Publish Packages to GitHub Packages" \
  --field version=major
```

#### Force Publish All Packages (ignore change detection)
```bash
gh workflow run "Publish Packages to GitHub Packages" \
  --field version=patch \
  --field force_publish_all=true
```

### 3. Development Version Publishing

For development branches, you can trigger the workflow to publish dev versions:

```bash
# From your feature branch
gh workflow run "Publish Packages to GitHub Packages" \
  --ref your-feature-branch \
  --field version=patch
```

This will:
- Run tests and lint checks on your branch
- Bump versions for changed packages
- Publish with development tags if configured

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

All packages are published under the `@hipponot` scope:

```json
{
  "name": "@hipponot/package-name",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com",
    "access": "public"
  }
}
```

## Installing Published Packages

### Configure npm for GitHub Packages

```bash
# Set registry for @hipponot scope
npm config set @hipponot:registry https://npm.pkg.github.com

# Or create .npmrc file
echo "@hipponot:registry=https://npm.pkg.github.com" >> .npmrc
```

### Install packages
```bash
# Install specific packages
npm install @hipponot/api-core
npm install @hipponot/config
npm install @hipponot/db
npm install @hipponot/logger

# Or using pnpm
pnpm add @hipponot/api-core
```

## Monitoring and Debugging

### Check Workflow Status
```bash
# List recent workflow runs
gh run list --workflow="Publish Packages to GitHub Packages"

# View specific run details  
gh run view <run-id>

# View logs for specific run
gh run view <run-id> --log
```

### Check Published Packages
```bash
# List packages in GitHub Packages
gh api repos/:owner/:repo/packages

# View package versions
npm view @saga-soa/api-core versions --json
```

### Common Issues

#### 1. "Package already exists"
This is normal - the workflow will skip republishing if the version already exists.

#### 2. "Authentication failed"
Check that `GITHUB_TOKEN` has `packages: write` permission.

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

The workflow is defined in `.github/workflows/publish-packages.yml` and includes:

- **Change Detection**: Uses Turborepo to find affected packages
- **Matrix Testing**: Parallel lint/test execution per package
- **Dependency-Aware Building**: Builds packages in correct order
- **Smart Publishing**: Only publishes changed, non-private packages
- **GitHub Packages Integration**: Automatic registry configuration
- **Release Summaries**: Detailed output of what was published

For more details, see the workflow file itself.
