# [Domain] [Applications|Libraries]

> [Brief 1-sentence description: e.g., "Node.js server applications, APIs, and command-line tools"]

## Responsibilities

This directory contains all [domain] [applications|libraries]:
- [Category 1] (e.g., API servers - GraphQL, REST, tRPC)
- [Category 2] (e.g., Web application servers)
- [Category 3] (e.g., Command-line tools and utilities)
- [Category 4] (e.g., Real-time communication servers)
- [Category 5] (e.g., Background job processors)

**Parent Context:** Part of [[domain] projects](../CLAUDE.md), which includes both applications and shared libraries.

## Tech Stack

- **Frameworks**: [Express, Fastify, Apollo Server, tRPC, Socket.IO, Sinatra]
- **APIs**: [GraphQL, REST, tRPC, WebSockets]
- **Databases**: [MongoDB, MySQL, PostgreSQL, Redis]
- **Testing**: [Vitest, Jest, Minitest] (modern), [framework] (legacy)
- **Build**: [nx, bit.js, bundler] (modern), [other] (legacy)
- **Package Managers**: [pnpm] (preferred), [yarn] (legacy)

## Key [Applications|Libraries]

| [App|Library] | Purpose | Tech | Status |
|---------------|---------|------|--------|
| [[project_a]](./[project_a]/CLAUDE.md) | [Brief description] | [Tech stack] | **Primary** |
| [project_b] | [Brief description] | [Tech stack] | Modern |
| [project_c] | [Brief description] | [Tech stack] | Active |
| [project_d] | [Brief description] | [Tech stack] | Legacy |

**See individual project directories for detailed CLAUDE.md files.**

## Command Discovery

Each [application|library] has its own build configuration:
- Modern [apps|libs]: `[config file]` ([build tool] configuration)
- Legacy [apps|libs]: `[config file]` ([build tool] configuration) or `package.json` scripts

**Common patterns:**
```bash
# Modern [applications|libraries] ([build tool] + [package manager])
cd <[application|library]>
[package manager] install
[build command]
[test command]

# Legacy [applications|libraries] ([build tool] + [package manager])
cd <[application|library]>
[package manager] install
[build command]
[test command]
```

For comprehensive build/test commands, see each [application|library]'s CLAUDE.md.

## Convention Deviations

**⚠️ Conventions vary by [application|library]:**

**[project_a]** (non-standard):
- Uses **[deviation]** for [context]
- [Rationale]
- See [[project_a]/CLAUDE.md]([project_a]/CLAUDE.md) and [[project_a]/decisions/NNN]([project_a]/decisions/NNN-decision.md)

**All other [applications|libraries]** (standard):
- Use **[standard convention]** for [context]
- Follow standard [language] conventions

**Package managers:**
- Check lock files: `[lock file patterns]`
- Using wrong package manager breaks builds

## [Application|Library] Categories

### [Category 1: e.g., Primary APIs]
- **[project_a]** - [Brief description]
- **[project_b]** - [Brief description]

### [Category 2: e.g., Real-Time Servers]
- **[project_c]** - [Brief description]
- **[project_d]** - [Brief description]

### [Category 3: e.g., Admin Tools]
- **[project_e]** - [Brief description]
- **[project_f]** - [Brief description]

### Legacy [Applications|Libraries]
- **[old_project]** - Being phased out or migrated
- **attic/** - Deprecated [applications|libraries]

## Development Patterns

**Starting work on a [application|library]:**
1. Read the [application|library]'s CLAUDE.md file (if it exists)
2. Check package manager (look for lock file)
3. Check build system ([config file] vs [config file])
4. Install dependencies with correct package manager
5. Review any [application|library]-specific conventions

**Testing locally:**
```bash
# Most [applications|libraries] can run/test locally
[example command]

# Check package.json for scripts
[package manager] start  # or test
```

**Deploying:**
```bash
[deployment command]
```

## Common Workflows

See [root workflows.md](../../docs/workflows.md) for:
- [Workflow 1]
- [Workflow 2]
- [Workflow 3]
- [Workflow 4]

## Detailed Documentation

- [[key_project] Documentation]([project]/CLAUDE.md) - Main [API|library] (comprehensive docs)
- [[Domain] Projects](../CLAUDE.md) - Parent context ([apps] + [libs])
- [Root Architecture](../../docs/architecture.md) - Monorepo structure
- [Root Development Guide](../../docs/development.md) - Build systems overview
- [Root Workflows](../../docs/workflows.md) - Testing, deployment, debugging

---

*Target: ~500 tokens | Last updated: [YYYY-MM-DD]*
