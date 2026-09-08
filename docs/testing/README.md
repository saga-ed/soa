# Testing Documentation

Shared testing patterns for SOA, Thrive, and Coach repositories.

## Quick Routing

| Working On | Read This |
|------------|-----------|
| Any test file | Start here, then see runtime-specific docs |
| Node.js backend or packages | [.claude/rules/testing-node.md](../../.claude/rules/testing-node.md) |
| Web frontend | [.claude/rules/testing-web.md](../../.claude/rules/testing-web.md) |

The runtime-specific docs above are `.claude/rules/` files — they load
automatically when Claude touches a matching path, not just on manual click.

## Shared Documentation

| Document | Content |
|----------|---------|
| [philosophy.md](./philosophy.md) | ARES framework, core principles |
| [conventions.md](./conventions.md) | File naming, directory structure |
| [builders.md](./builders.md) | Fishery patterns, test data |

## Test Commands

```bash
pnpm test              # Root-level vitest run
turbo run test         # Every package's own test script
```

Per-package `test:unit` / `test:int` / `test:smoke` scripts exist where a
package defines them (not universal — check that package's `package.json`).

## Cross-Repo Usage

Thrive and Coach reference these shared patterns:

```markdown
# In thrive/CLAUDE.md or coach/CLAUDE.md:
See [soa/docs/testing/](~/dev/soa/docs/testing/) for shared testing patterns.
```

Repo-specific testing concerns go in each repo's own testing docs.
