# [Workspace Name]

> [Brief 1-2 sentence description of what this workspace contains]

## Responsibilities

This workspace is responsible for:
- Primary responsibility 1
- Primary responsibility 2
- Primary responsibility 3

## Tech Stack

- **Languages**: [TypeScript, JavaScript, Ruby, Python]
- **Build Tools**: [nx, bit.js, etc.]
- **Package Managers**: [pnpm, yarn, npm - note if varies]
- **Databases**: [MongoDB, MySQL, PostgreSQL, Redis]
- **APIs**: [GraphQL, REST, tRPC, Socket.IO]

## Project Structure

```
[workspace]/
├── [domain_1]/       # [Brief description]
│   ├── [tier_1]/     # [Applications/Libraries]
│   └── [tier_2]/     # [Applications/Libraries]
├── [domain_2]/       # [Brief description]
└── [tools]/          # [Build/deployment tooling]
```

**Key Projects:**
- `[project_a]/` - [One-line description] (see [CLAUDE.md](./path/to/project_a/CLAUDE.md))
- `[project_b]/` - [One-line description] (see [CLAUDE.md](./path/to/project_b/CLAUDE.md))
- `[project_c]/` - [One-line description]

## Command Discovery

Build commands vary by project. Check `project.json` (nx) or `bit.yaml` (bit.js) in each project directory.

**Quick reference:**
```bash
# [Build system 1] projects
[example build command]

# [Build system 2] projects (if applicable)
[example build command]

# Package managers: [list package managers and when to use each]
# Check lock files: [list lock file patterns]
```

For comprehensive build/test/deploy commands, see [docs/development.md](./docs/development.md).

## Convention Deviations

**[If applicable] ⚠️ Important differences from standard practices:**
- [Deviation 1] - [Brief explanation]
- [Deviation 2] - [Brief explanation]
- Check project-specific CLAUDE.md files for local conventions

See project-specific CLAUDE.md files for detailed conventions.

## Key Design Decisions

- `decisions/001-[decision].md` - [Brief description]
- `decisions/002-[decision].md` - [Brief description]

Full index: [decisions/README.md](./decisions/README.md)

## Common Workflows

**[Workflow 1 name]:**
```bash
[example commands]
```

**[Workflow 2 name]:**
```bash
[example commands]
```

See [docs/workflows.md](./docs/workflows.md) for detailed workflow documentation.

## Detailed Documentation

- [Architecture](./docs/architecture.md) - System design, monorepo structure
- [Development Guide](./docs/development.md) - Build systems, package managers
- [Deployment](./docs/deployment.md) - VM deployment, Docker
- [Workflows](./docs/workflows.md) - Testing, fixtures, observability
- [Design Decisions](./decisions/README.md) - Architecture decision records

---

*Target: ~500 tokens | Last updated: [YYYY-MM-DD]*
