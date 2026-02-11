# [Project Name]

> [Brief 1-2 sentence description of what this project does]

## Responsibilities

This [application|library] is responsible for:
- Primary responsibility 1
- Primary responsibility 2
- Primary responsibility 3
- Key feature or capability

**Parent Context:** Part of [parent tier](../CLAUDE.md), which contains [description of parent scope].

## Tech Stack

- **Language**: TypeScript/JavaScript/Ruby
- **Framework**: [Express, Fastify, Sinatra, etc.]
- **APIs**: [GraphQL, REST, tRPC, Socket.IO]
- **Databases**: [MongoDB, PostgreSQL, MySQL, Redis]
- **Testing**: [Vitest, Jest, Minitest]
- **Build**: [nx, bit.js, etc.]
- **Package Manager**: [pnpm, yarn, npm]

## Project Structure

```
[project_name]/
├── src/              # Source code
│   ├── main.ts       # Entry point
│   ├── [key_dir]/    # [Purpose]
│   └── [key_dir]/    # [Purpose]
├── tests/            # Test suites
├── docs/             # Detailed documentation
├── [if applicable] [sub_projects]/
└── project.json      # nx config (or bit.yaml, package.json)
```

**[If applicable] Key Sub-projects:**
- `[sub_project_a]/` - [One-line description] (see [CLAUDE.md](./sub_project_a/CLAUDE.md))
- `[sub_project_b]/` - [One-line description]

## Command Discovery

Commands are in `[project.json|package.json|bit.yaml]`.

**Key commands:**
```bash
# Build
[build command]

# Test
[test command]

# Lint
[lint command]

# Start
[start command]
```

For comprehensive commands, see [docs/development.md](./docs/development.md).

## Convention Deviations

**[If applicable] ⚠️ This project uses [convention]:**
- [Deviation 1 with example]
- [Deviation 2 with example]

```[language]
// ✅ Correct for this project
[code example]

// ❌ Incorrect
[code example]
```

**Rationale:** See `decisions/NNN-[decision-name].md`

For all conventions, see [docs/conventions.md](./docs/conventions.md).

**[If applicable] ⚠️ Package manager:**
- Uses **[pnpm|yarn|npm]** (check `[lock file name]`)
- Using wrong package manager breaks builds

**[If applicable] ⚠️ Build system:**
- Uses [build system] ([modern|legacy])
- [Location or special notes]

## [If applicable] Key Features/Concepts

### [Feature/Concept 1]
[2-3 sentences describing key feature or concept]

### [Feature/Concept 2]
[2-3 sentences describing key feature or concept]

## Dependencies

**Internal:**
- Parent: [parent tier](../CLAUDE.md)
- Sibling projects: [related projects]
- Shared libraries: [internal dependencies]

**External:**
- [Database details and collections/tables]
- [External services or APIs]
- [Major libraries]

## [If applicable] API Overview

**[If GraphQL/REST] Key Operations:**
- [List main endpoints or queries/mutations]

**[If library] Exported Functions:**
- [List main public API]

**Schema/Types**: [Path to API definitions]

## Common Workflows

**Development:**
```bash
cd [path/to/project]
[package manager] install
[dev command]
```

**Building:**
```bash
[build command with options]
```

**Testing:**
```bash
[test command]
[test with watch]
[test with coverage]
```

**[If applicable] Deploying:**
```bash
[deployment command]
```

## [If applicable] Database

**Collections/Tables:**
- `[collection_1]` - [Purpose]
- `[collection_2]` - [Purpose]

**[If applicable] Migrations:**
- [Migration strategy or location]

## Key Design Decisions

- `decisions/001-[decision].md` - [Brief description]
- `decisions/002-[decision].md` - [Brief description]

Full index: [decisions/README.md](./decisions/README.md)

## 📝 Documentation Directive

**If you discover critical or unconventional information:**
1. Add to this CLAUDE.md (if essential and keeps us under 500 tokens)
2. Or create detailed docs in `./docs/` and link from here
3. For major decisions, create ADRs in `decisions/` directory

**Examples of critical information:**
- Unusual build requirements
- Non-obvious dependencies
- Security considerations
- Performance implications

## Detailed Documentation

- [Architecture](./docs/architecture.md) - System design and structure
- [Development Guide](./docs/development.md) - Build, test, deploy
- [Conventions](./docs/conventions.md) - Code style and patterns
- [Parent Context](../CLAUDE.md) - [Parent tier] overview
- [Design Decisions](./decisions/README.md) - ADRs

---

*Target: ~500 tokens | Last updated: [YYYY-MM-DD]*
