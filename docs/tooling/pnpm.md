# pnpm Rules

## VSCode / Claude Code Plugin Context

When running in VSCode or Claude Code plugin context, `NODE_ENV=production` is set by default, which causes dev dependencies to be skipped during installation.

**Always use:**
```bash
NODE_ENV=development pnpm install
```

**Never use bare:**
```bash
pnpm install  # May skip devDependencies in VSCode context
```

## Why This Happens

VSCode extensions run with `NODE_ENV=production` set in the environment. When pnpm sees this, it respects npm's convention of skipping `devDependencies` in production mode.

## Affected Repositories

This rule applies to all pnpm-based repos:
- soa
- thrive
- coach
