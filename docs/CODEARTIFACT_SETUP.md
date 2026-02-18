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
| `@saga-ed/soa-trpc-codegen` | tRPC code generation |
| `@saga-ed/soa-zod2ts` | Zod to TypeScript schema generation |

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
