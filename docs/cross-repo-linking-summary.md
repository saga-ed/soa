# Cross-Repo SOA Package Linking

## What It Does

The `cross-repo-link.sh` script lets you toggle between using **local SOA packages** (from your filesystem) and **published packages** (from npm registry). This is essential for development when you need to test SOA changes in consuming repos (thrive, coach) without publishing.

## Why It Matters

- **Fast iteration**: Test SOA changes immediately in thrive/coach without npm publish cycle
- **Debug together**: Step through SOA code while debugging thrive/coach issues
- **Safe workflow**: Clear on/off toggle prevents accidentally committing local overrides

## Quick Start

```bash
# From thrive or coach repo:

# Initialize config (first time only)
../soa/scripts/cross-repo-link.sh init

# Enable local linking
../soa/scripts/cross-repo-link.sh on

# Check current state
../soa/scripts/cross-repo-link.sh status

# Disable before committing
../soa/scripts/cross-repo-link.sh off
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  thrive/coach repo                                          │
│                                                             │
│  package.json                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  "pnpm": {                                          │   │
│  │    "overrides": {                                   │   │
│  │      "@saga-ed/soa-logger": "link:../soa/packages/  │   │
│  │                              node/logger"           │   │
│  │    }                                                │   │
│  │  }                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│                    pnpm install                             │
│                           │                                 │
└───────────────────────────┼─────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
    ┌─────────────────┐         ┌─────────────────┐
    │  LINKED (on)    │         │  REGISTRY (off) │
    │                 │         │                 │
    │  Uses local     │         │  Uses published │
    │  ../soa/packages│         │  npm packages   │
    └─────────────────┘         └─────────────────┘
```

## Configuration

Each consuming repo needs a `soa-link.json` file:

```json
{
  "soaPath": "../soa",
  "packages": {
    "@saga-ed/soa-api-core": "packages/node/api-core",
    "@saga-ed/soa-logger": "packages/node/logger",
    "@saga-ed/soa-db": "packages/node/db",
    "@saga-ed/soa-config": "packages/core/config"
  }
}
```

**Fields:**
- `soaPath`: Relative path from consuming repo to soa
- `packages`: Map of npm package names to their paths within soa

## Commands

| Command | Description |
|---------|-------------|
| `on` | Enable local linking (adds pnpm overrides) |
| `off` | Disable local linking (removes overrides) |
| `status` | Show current state and linked packages |
| `init` | Create default soa-link.json config |
| (none) | Toggle current state |

## Typical Workflow

```bash
# 1. Working on a feature that spans soa and thrive

# In soa: make changes to @saga-ed/soa-logger
cd ~/dev/soa
# edit packages/node/logger/src/...

# 2. Test in thrive with local packages
cd ~/dev/thrive
../soa/scripts/cross-repo-link.sh on
# Now thrive uses your local soa-logger changes

# 3. Iterate until working
# Changes in soa are immediately available

# 4. Before committing thrive changes
../soa/scripts/cross-repo-link.sh off
git add . && git commit -m "..."
```

## Important Warnings

**Do NOT commit with linking enabled:**
```bash
# Always check before committing
../soa/scripts/cross-repo-link.sh status

# If linked, disable first
../soa/scripts/cross-repo-link.sh off
```

**The script will warn you:**
```
⚠️  Do not commit package.json with local overrides!
Run './scripts/cross-repo-link.sh off' before committing.
```

## Prerequisites

- **jq**: Required for JSON manipulation (`sudo apt-get install jq`)
- **pnpm**: Package manager (script runs `pnpm install` automatically)

## Available Packages

Default packages that can be linked:

| Package | SOA Path |
|---------|----------|
| `@saga-ed/soa-api-core` | `packages/node/api-core` |
| `@saga-ed/soa-api-util` | `packages/node/api-util` |
| `@saga-ed/soa-config` | `packages/core/config` |
| `@saga-ed/soa-db` | `packages/node/db` |
| `@saga-ed/soa-logger` | `packages/node/logger` |
| `@saga-ed/soa-rabbitmq` | `packages/node/rabbitmq` |
| `@saga-ed/soa-pubsub-server` | `packages/node/pubsub-server` |
| `@saga-ed/soa-pubsub-client` | `packages/node/pubsub-client` |
| `@saga-ed/soa-redis-core` | `packages/node/redis-core` |
| `@saga-ed/soa-aws-util` | `packages/node/aws-util` |
| `@saga-ed/soa-test-util` | `packages/node/test-util` |

## Troubleshooting

**"SOA packages not found"**
- Check that `soaPath` in soa-link.json points to correct location
- Verify soa repo is checked out at that path

**"jq is required"**
- Install jq: `sudo apt-get install jq`

**Changes not reflecting**
- Ensure soa packages are built: `cd ../soa && pnpm build`
- Try `pnpm install` in consuming repo

---

*Script location: [scripts/cross-repo-link.sh](../scripts/cross-repo-link.sh)*
