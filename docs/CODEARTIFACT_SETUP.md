# AWS CodeArtifact Setup for SOA Packages

This document describes how SOA packages are published to AWS CodeArtifact and how to consume them.

## Overview

SOA packages are published to AWS CodeArtifact under the `@saga-ed` scope:

- **CodeArtifact Domain:** `saga`
- **CodeArtifact Repository:** `saga_js`
- **AWS Account:** `531314149529`
- **Region:** `us-west-2`
- **Registry URL:** `https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/`

## Published Packages

| Package | Description |
|---------|-------------|
| `@saga-ed/soa-api-core` | Core API framework (Express, GraphQL, tRPC) |
| `@saga-ed/soa-api-util` | API utility functions |
| `@saga-ed/soa-config` | Configuration management |
| `@saga-ed/soa-db` | Database utilities (MongoDB) |
| `@saga-ed/soa-logger` | Logging utilities (Pino) |
| `@saga-ed/soa-pubsub-client` | PubSub client library |
| `@saga-ed/soa-pubsub-core` | PubSub core types/interfaces |
| `@saga-ed/soa-tgql-codegen` | TypeGraphQL code generation |
| `@saga-ed/soa-trpc-base` | Shared tRPC initialization factory |

## Local Development

### Prerequisites

- AWS CLI installed and configured with access to the `531314149529` account
- pnpm installed

### Authentication

Before installing or publishing packages, authenticate with CodeArtifact:

```bash
# From the soa repo root
pnpm co:login

# Verify authentication
pnpm co:whoami
```

The `co:login` script:
1. Gets a temporary auth token from CodeArtifact (valid for 12 hours)
2. Sets a **scoped** `_authToken` entry in `~/.npmrc` for the saga_js registry URL only

> **Warning:** Never use `aws codeartifact login --tool npm`. It overwrites the **default registry** in `~/.npmrc` to point at CodeArtifact, which breaks `pnpm install` for all public npm packages. Always use `get-authorization-token` + scoped `npm config set` instead.

Most repos also have a `preinstall` hook that runs `co:login` automatically before `pnpm install`. See [package-registry-quickstart.md](./package-registry-quickstart.md#preinstall-hooks) for details.

### Installing Packages

Once authenticated, packages can be installed normally:

```bash
pnpm add @saga-ed/soa-logger
```

## CI/CD Publishing

Packages are published via GitHub Actions using OIDC authentication (no long-lived credentials).

### Workflow: `publish-codeartifact.yml`

Manually triggered with options:
- **version:** `patch`, `minor`, or `major`
- **publish_target:** `codeartifact`, `github`, or `both`
- **skip_tests:** Skip test suite (use with caution)

The workflow:
1. Runs tests and builds
2. Bumps versions across all publishable packages
3. Publishes in dependency order to selected targets

### IAM Role

GitHub Actions authenticates via the `SOADeployRole` IAM role (`/github-actions-role/SOADeployRole`), which has:
- `codeartifact:GetAuthorizationToken` - Get temp auth token
- `codeartifact:PublishPackageVersion` - Publish packages
- `codeartifact:PutPackageMetadata` - Update package metadata

## Manual Publishing (Dev Versions)

Most package publishes go through `publish-codeartifact.yml` on merge to main. Use the manual flow below when you need to push a pre-release version from an in-flight branch — typically because a consumer in another repo (program-hub, rostering, etc.) needs to pin the change for its own preview deploy or PR review **before** the soa change has merged.

### Profile selection: prod, in-account

**Use `saga-deploy-prod`** (AppDeploy in the prod account, `531314149529`).

The CodeArtifact `saga` domain lives in the prod account. Publishing requires an **in-account principal** because the cross-account allow-list on the domain is intentionally read-only:

```yaml
# iac repo: cloudformation_templates/codeartifact/domain/template.yaml
# AllowDevAccountAccess statement
Action:
  - codeartifact:GetAuthorizationToken
  - codeartifact:ReadFromRepository
  # ... 12 read-only actions, no PublishPackageVersion / PutPackageMetadata
```

The dev account's AppDeploy role does carry `SagaCap-CodeArtifactPublish` (the IAM grant exists), but the prod-side resource policy blocks the cross-account write — so a `pnpm publish` under `saga-deploy-dev` returns 403 with the (misleading) error `no resource-based policy allows the codeartifact:PublishPackageVersion action`. Same-account publish from `saga-deploy-prod` doesn't traverse that boundary.

### Why one CodeArtifact, not two

Considered and rejected: a dedicated dev CodeArtifact domain that would isolate dev artifacts from prod ones.

The trade-off is auth-token DX. Unlike ECR — where `aws ecr get-login-password` is one command and the credential is fungible across registries — CodeArtifact's auth token is **per-registry**, set into `.npmrc` keyed by the full registry hostname. A second domain would mean every developer and every CI workflow has to know which domain to log into, pin the right registry per dependency, and not mix them in a single `pnpm install`. That's a meaningful complexity tax for marginal isolation gain. The naming convention (`*-dev.N` versions) carries the dev-vs-prod signal instead.

### Dev-version naming + lifecycle

| Stage | Version pattern | Example | Lifetime |
|---|---|---|---|
| In-flight feature branch | `MAJOR.MINOR.PATCH-dev.N` | `0.1.0-dev.2` | Bump `dev.N` per iteration. Pinned by consumer feature branches that depend on the change. |
| Production approval | `MAJOR.MINOR.PATCH` | `0.1.0` | Cut once the feature is approved to merge — typically by `publish-codeartifact.yml` on the merge commit. This is the version production-deploying branches pin. |

Dev versions are temporary by design. Once a non-dev release exists for the same minor (or the feature is abandoned), the `*-dev.*` versions become safe to delete.

### Publish recipe

```bash
# 1. Bump the package's version in package.json (e.g. 0.1.0-dev.1 → 0.1.0-dev.2)

# 2. Auth + publish from the prod account
export CODEARTIFACT_AUTH_TOKEN=$(aws --profile saga-deploy-prod codeartifact get-authorization-token \
  --domain saga --domain-owner 531314149529 --query authorizationToken --output text)
npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN

# 3. Build + publish (workspace-package example)
pnpm --filter @saga-ed/<package> build
pnpm --filter @saga-ed/<package> publish --no-git-checks --access restricted

# 4. In the consumer repo: bump the dep in package.json and `pnpm install` to lock the new version.
#    (`pnpm update <pkg> --recursive` alone won't move the lockfile if the specifier is pinned.)
```

### Cleanup of dev versions

There's no automated reaper today; treat cleanup as a quarterly hygiene pass or on-demand when a package's version list gets noisy. Safe-to-delete criteria:

- A non-dev version exists for the same `MAJOR.MINOR` (the feature shipped — earlier `*-dev.N` versions are no longer pinned by anything live).
- The corresponding feature branch is closed without merging.

```bash
# List dev versions for a package
aws codeartifact list-package-versions \
  --profile saga-deploy-prod \
  --domain saga --domain-owner 531314149529 \
  --repository saga_js \
  --format npm --namespace saga-ed --package <pkg> \
  --query "versions[?contains(version, '-dev.')].version" --output table

# Delete the ones that are safe to remove
aws codeartifact delete-package-versions \
  --profile saga-deploy-prod \
  --domain saga --domain-owner 531314149529 \
  --repository saga_js \
  --format npm --namespace saga-ed --package <pkg> \
  --versions 0.1.0-dev.1 0.1.0-dev.2  # etc.
```

## Consuming Packages in Other Projects

### 1. Configure .npmrc

Add to your project's `.npmrc`:

```npmrc
@saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
```

### 2. Authenticate

#### Local Development

```bash
# Get auth token (valid 12 hours)
export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
  --domain saga \
  --domain-owner 531314149529 \
  --query authorizationToken \
  --output text)

# Configure npm
npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN
```

#### GitHub Actions

```yaml
- name: Configure AWS credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::531314149529:role/your-role
    aws-region: us-west-2

- name: Get CodeArtifact auth token
  run: |
    CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
      --domain saga \
      --domain-owner 531314149529 \
      --query authorizationToken \
      --output text)
    echo "CODEARTIFACT_AUTH_TOKEN=$CODEARTIFACT_AUTH_TOKEN" >> $GITHUB_ENV
    echo "::add-mask::$CODEARTIFACT_AUTH_TOKEN"

- name: Configure npm for CodeArtifact
  run: |
    npm config set @saga-ed:registry=https://saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/
    npm config set //saga-531314149529.d.codeartifact.us-west-2.amazonaws.com/npm/saga_js/:_authToken=$CODEARTIFACT_AUTH_TOKEN
```

### 3. Install Packages

```bash
pnpm add @saga-ed/soa-logger @saga-ed/soa-config
```

## Troubleshooting

### "401 Unauthorized"

Auth token may have expired. Re-run:
```bash
pnpm co:login
```

### Public npm packages fail to install (403/E404 for lodash, express, etc.)

Your `~/.npmrc` likely has a stale `registry=` line pointing everything at CodeArtifact. Fix:
```bash
# Check for the problem
grep "^registry=.*codeartifact" ~/.npmrc

# Remove it
sed -i '/^registry=.*codeartifact/d' ~/.npmrc
```

This happens if someone previously ran `aws codeartifact login --tool npm`, which sets the default registry globally. The `morning-auth.sh` script now auto-cleans this, but if you hit it manually, the above fix resolves it.

### "404 Not Found"

Package may not be published yet. Check the CodeArtifact console:
```bash
aws codeartifact list-package-versions \
  --domain saga \
  --repository saga_js \
  --format npm \
  --package soa-logger \
  --namespace saga-ed
```

### Checking Available Packages

```bash
# List all packages in the repository
aws codeartifact list-packages \
  --domain saga \
  --domain-owner 531314149529 \
  --repository saga_js
```
