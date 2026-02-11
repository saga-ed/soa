# [Component Name]

> [Brief 1-sentence description of what this component does]

## Responsibilities

This [component|sector|module] is responsible for:
- Primary responsibility 1
- Primary responsibility 2
- Primary responsibility 3

**Parent Context:** Part of [parent_name](../CLAUDE.md), which is [brief description of parent].

## Tech Stack

- **Language**: TypeScript/JavaScript/Ruby (with [camelCase|snake_case] convention)
- **Framework**: [Express, Apollo, etc.]
- **Database**: [MongoDB, PostgreSQL, etc.]
- **Key Dependencies**: [Major libraries used]
- **Testing**: [Vitest, Jest, Minitest, etc.]

## Key Files

- `main_file.ts` - [Purpose and what it does]
- `helper.ts` - [Purpose]
- `routes.ts` - [REST endpoints] or `resolvers.ts` - [GraphQL resolvers]
- `gql/types/` - [GraphQL schema definitions]
- `schema/` - [Generated TypeScript types]

## Dependencies

**Internal:**
- Parent: [parent_name](../CLAUDE.md)
- Sibling components: [component_a](../component_a/CLAUDE.md), [component_b](../component_b/CLAUDE.md)
- Core helpers: [list of shared helpers used]

**External:**
- Database: [collection/table names]
- External services: [APIs, third-party services]
- Libraries: [major external dependencies]

## Command Discovery

[Component name] builds as part of [parent project]. See [parent CLAUDE.md](../CLAUDE.md) for build commands.

**[If applicable] Component-specific commands:**
```bash
# Build this component's schema/types
npx nx build [component-name]

# Test this component
pnpm test [path/to/tests]
```

## Key Concepts

### [Concept 1]
[2-3 sentences explaining important concept]

### [Concept 2]
[2-3 sentences explaining important concept]

## [API/Interface Section - if applicable]

**Key Operations:**
- Queries: [list key queries]
- Mutations: [list key mutations]
- Functions: [list key exported functions]

**Schema/Types**: [Path to schema definitions]

## Convention Deviations

**[If applicable] ⚠️ This component follows [parent] conventions:**

```[language]
// ✅ Correct style for this component
const variable_name = "value";

// ❌ Incorrect
const variableName = "value";
```

See [parent conventions](../docs/conventions.md).

**[If applicable] ⚠️ Component-specific deviations:**
- [List any deviations unique to this component]

## Common Workflows

**[Workflow 1 name]:**
```[language]
// Example code showing common workflow
const result = await doSomething();
```

**[Workflow 2 name]:**
```[language]
// Example code showing common workflow
```

## Testing

[Component name] has test coverage in `tests/[path]/`:
- Unit tests: [What's tested]
- Integration tests: [What's tested]
- [Specific testing considerations]

See [parent testing guide](../docs/testing.md).

## 📝 Documentation Directive

**If you discover critical or unconventional information about [component name]:**
1. Add to this CLAUDE.md (if essential and keeps us under 500 tokens)
2. Or create detailed docs in `./docs/` and link from here
3. For major decisions about [component] patterns, document in [parent decisions](../decisions/)

**Examples of critical information:**
- [Component-specific example 1]
- [Component-specific example 2]
- [Component-specific example 3]

## Detailed Documentation

- [Parent Architecture](../docs/architecture.md) - [Parent] design principles
- [Parent Conventions](../docs/conventions.md) - Code style
- [Parent Development Guide](../docs/development.md) - Build, test, deploy

---

*Target: ~500 tokens | Last updated: [YYYY-MM-DD]*
