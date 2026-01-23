# Testing Documentation

Shared testing patterns for SOA, Thrive, and Coach repositories.

## Quick Routing

| Working On | Read This |
|------------|-----------|
| Any test file | Start here, then see runtime-specific docs |
| Node.js backend | [apps/node/claude/testing.md](../../apps/node/claude/testing.md) |
| Web frontend | [apps/web/claude/testing.md](../../apps/web/claude/testing.md) |
| Node packages | [packages/node/claude/testing.md](../../packages/node/claude/testing.md) |

## Shared Documentation

| Document | Content |
|----------|---------|
| [philosophy.md](./philosophy.md) | ARES framework, core principles |
| [conventions.md](./conventions.md) | File naming, directory structure |
| [builders.md](./builders.md) | Fishery patterns, test data |

## Test Commands

```bash
pnpm test              # All tests
pnpm test:unit         # Unit tests only
pnpm test:int          # Integration tests
pnpm test:smoke        # Smoke tests
```

## Cross-Repo Usage

Thrive and Coach reference these shared patterns:

```markdown
# In thrive/CLAUDE.md or coach/CLAUDE.md:
See [soa/claude/testing/](~/dev/soa/claude/testing/) for shared testing patterns.
```

Repo-specific testing concerns go in each repo's own `claude/testing/` directory.
