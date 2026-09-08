  # Hierarchical CLAUDE.md Organization for SOA, Thrive, and Coach Repos

## Research Plan Document

**Scope**: Research and recommendations only (no implementation)
**Purpose**: Inform pair session with test engineers and guide future implementation

---

## Executive Summary

This document adapts the hierarchical CLAUDE.md approach from PR 7876 in nimbee for the three related repos: **soa**, **thrive**, and **coach**. These repos share SOA infrastructure but are independent projects with project-specific constraints.

**Key Decisions Made:**
1. **Context Loading**: Auto-detect from files + slash command fallback for progressive disclosure
2. **Cross-Repo Docs**: soa as source of truth, thrive/coach reference via paths
3. **Current Scope**: Research plan only (implementation deferred)

**Key Difference from Nimbee**: These repos use **Turbo** (not Nx/bit.js) and are consistently TypeScript-based with pnpm.

---

## Research Findings

### 1. PR 7876 Key Concepts (From Nimbee)

**6-Level Hierarchy:**
1. Root (`/`) - Workspace-wide context
2. Tech Domain (`/edu/js/`) - Language/technology domain
3. Tier (`/edu/js/app/`) - Application vs library tier
4. Project (`/saga_api/`) - Individual application/library
5. Sub-Project (`/sectors/`) - Logical groupings within project
6. Leaf (`/iam/`) - Specific component/module

**Token Budget:**
- Target: ~500 tokens (~375 words)
- Maximum: 1000 tokens (~750 words)
- Progressive disclosure: Extract details to `docs/` files

**Required CLAUDE.md Sections:**
1. Title & tagline
2. Responsibilities
3. Parent Context (except root)
4. Tech Stack
5. Command Discovery
6. Convention Deviations (marked with ⚠️)
7. Documentation Directive
8. Detailed Documentation links

**Supporting Infrastructure:**
- `docs/` directory for detailed documentation
- `decisions/` directory for Architecture Decision Records (ADRs)
- `claude/skills/` directory for reusable skills
- Validation scripts (token budget, links, structure)
- GitHub Actions workflow for documentation validation

### 2. SOA Current State

**Structure:**
```
soa/
├── apps/
│   ├── examples/          # Example applications
│   │   ├── trpc-api/
│   │   ├── rest-api/
│   │   └── tgql-api/
│   ├── docs/
│   └── projects/
├── packages/              # Shared packages (17 total)
│   ├── api-core/
│   ├── pubsub-client/
│   ├── pubsub-server/
│   ├── db/
│   ├── logger/
│   ├── config/
│   └── ...
├── CLAUDE.md              # Current: 30 lines, permissions-focused only
├── turbo.json             # Build orchestration
└── docs/                  # Some existing docs
```

**Current CLAUDE.md Issues:**
- Only contains permissions/safety rules (~30 lines)
- Missing: responsibilities, tech stack, project structure, conventions
- No hierarchical documentation at package/app level

### 3. Testing Differences: SOA vs saga_api

| Aspect | SOA | saga_api |
|--------|-----|----------|
| Framework | Vitest | Jest (migrating to Vitest) |
| Database | In-memory (mongodb-memory-server) | Real Docker containers |
| Isolation | Per-test mocking | Per-test/worker isolated DBs |
| Labels | Directory-based (unit/integration) | Tag-based ([smoke], [acceptance]) |
| Setup | Minimal setup.ts | Complex jest.setup.ts (~370 lines) |
| Builders | Direct instantiation | Fishery factories + BaseBuilder |
| BDD | None | jest-cucumber with Gherkin |

**Questions for Test Engineers:**
1. Should SOA adopt Docker-based DB testing for integration tests?
2. Should SOA adopt test labeling system?
3. Should SOA adopt builder/factory patterns?
4. Should BDD support be added?

---

## Recommended Approach for SOA/Thrive/Coach

### Simplified Hierarchy (5 Levels)

Since these repos are simpler than nimbee (no multi-language, no legacy systems):

1. **Root** (`/CLAUDE.md`) - Repo-wide context
2. **Category** (`/packages/CLAUDE.md`, `/apps/CLAUDE.md`) - Packages vs Apps overview
3. **Runtime Tier** - Discriminates by runtime type:
   - `/apps/web/CLAUDE.md` - Frontend web applications (Browser runtime)
   - `/apps/node/CLAUDE.md` - Backend microservices (Node.js runtime)
   - `/packages/CLAUDE.md` - Shared libraries (runtime-agnostic or constrained)
4. **Project** (`/apps/node/trpc-api/CLAUDE.md`) - Individual package/app
5. **Leaf** (`/apps/node/trpc-api/sectors/*/CLAUDE.md`) - If needed for sectors

**Key Insight**: The Runtime Tier level provides context-specific documentation based on where code runs (browser vs Node.js), enabling progressive disclosure of runtime-relevant information.

### App-Level Runtime Discrimination

**Critical**: App-level CLAUDE.md files must distinguish between runtime types:

#### Frontend Web Applications
Files in: `apps/web/`, `apps/frontend/`, etc.

**Runtime-specific context:**
- Browser runtime (window, document, DOM APIs)
- Build target: Amplify, Vercel, or static hosting
- Framework: React, Vue, Svelte, etc.
- Bundler: Vite, webpack, etc.
- State management approach
- API client patterns (fetch, axios, tRPC client)
- Authentication: client-side token handling
- Environment: `VITE_*` or `NEXT_PUBLIC_*` variables

**Template section additions:**
```markdown
## Runtime Environment

**Type**: Frontend Web Application
**Target**: Browser (ES2020+)
**Build**: Vite → Amplify deployment

## Browser APIs Used
- LocalStorage for [purpose]
- Fetch API for API calls
- WebSocket for real-time features

## Environment Variables
All env vars must be prefixed with `VITE_`:
- `VITE_API_URL` - Backend API endpoint
- `VITE_AUTH_DOMAIN` - Auth0 domain
```

#### Backend Microservices
Files in: `apps/node/`, `apps/services/`, `apps/examples/trpc-api/`, etc.

**Runtime-specific context:**
- Node.js runtime (process, fs, Buffer APIs)
- Build target: Docker container → ECS
- Framework: Express, Fastify, tRPC, etc.
- Database connections: MongoDB, PostgreSQL, Redis
- Message queues: RabbitMQ, SQS
- Authentication: JWT validation, session management
- Environment: secrets, service URLs, database credentials

**Template section additions:**
```markdown
## Runtime Environment

**Type**: Backend Microservice
**Target**: Node.js 20+ (ESM)
**Build**: tsup → Docker → ECS deployment

## Infrastructure Dependencies
- MongoDB: `[collection names and purposes]`
- Redis: `[cache keys and patterns]`
- RabbitMQ: `[queues consumed/published]`

## Environment Variables
- `DATABASE_URL` - MongoDB connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - Token signing key (from Secrets Manager)

## Health & Observability
- Health endpoint: `GET /health`
- Metrics: [Datadog, CloudWatch, etc.]
- Logging: structured JSON via @soa/logger
```

#### Shared Libraries/Packages
Files in: `packages/`

**Runtime-agnostic context:**
- Must work in both browser and Node.js (or specify constraints)
- No direct runtime API usage (or clearly documented)
- ESM export patterns
- Peer dependencies vs bundled dependencies

**Template section additions:**
```markdown
## Runtime Compatibility

**Targets**: Node.js 20+, Browser (ES2020+)
**Module**: ESM only (no CJS)

## Runtime Constraints
- ⚠️ Uses `fs` module - Node.js only
- ⚠️ Uses `crypto.randomUUID()` - requires Node 19+ or browser with crypto API
```

### Directory Structure for Documentation

```
soa/
├── CLAUDE.md                          # Level 1: Root
├── docs/                              # Human-readable documentation
│   ├── README.md                      # Navigation index
│   ├── architecture.md                # System design
│   ├── development.md                 # Build, test, deploy
│   ├── conventions.md                 # Code style (ESM, ESLint, etc.)
│   └── testing.md                     # Testing strategy
├── claude/                            # Claude-readable context (visible)
│   ├── frontend/                      # Frontend framework patterns
│   │   ├── README.md                  # Framework choice guidance
│   │   ├── nextjs/                    # Legacy - SOA apps only
│   │   │   ├── getting-started.md
│   │   │   ├── app-router.md
│   │   │   └── trpc-client.md
│   │   ├── sveltekit/                 # Primary - for thrive/coach
│   │   │   ├── getting-started.md
│   │   │   ├── routing.md
│   │   │   └── amplify-deployment.md
│   │   └── shared/                    # Framework-agnostic patterns
│   │       ├── api-client-patterns.md
│   │       └── auth-integration.md
│   ├── skills/                        # Reusable skills
│   │   └── documentation-system/
│   │       ├── SKILL.md
│   │       ├── guides/
│   │       ├── templates/
│   │       └── scripts/
│   └── commands/                      # User commands
├── decisions/
│   ├── README.md                      # ADR index
│   └── 001-turbo-monorepo.md          # Example ADR
├── packages/
│   ├── CLAUDE.md                      # Level 2: Category (all packages overview)
│   │
│   ├── web/                           # Level 3: Runtime Tier - WEB/BROWSER
│   │   ├── CLAUDE.md                  # Web runtime tier docs
│   │   └── ui/                        # @saga-ed/soa-ui (React components)
│   │       └── CLAUDE.md
│   │
│   ├── node/                          # Level 3: Runtime Tier - NODE.JS
│   │   ├── CLAUDE.md                  # Node runtime tier docs
│   │   ├── api-core/                  # @saga-ed/soa-api-core
│   │   │   └── CLAUDE.md
│   │   ├── db/                        # @saga-ed/soa-db
│   │   │   └── CLAUDE.md
│   │   ├── logger/                    # @saga-ed/soa-logger
│   │   │   └── CLAUDE.md
│   │   └── ...                        # Other node packages
│   │
│   └── core/                          # Level 3: Runtime Tier - AGNOSTIC
│       ├── CLAUDE.md                  # Agnostic runtime tier docs
│       ├── config/                    # @saga-ed/soa-config
│       │   └── CLAUDE.md
│       ├── typescript-config/         # @saga-ed/soa-typescript-config
│       │   └── CLAUDE.md
│       └── eslint-config/             # @saga-ed/soa-eslint-config
│           └── CLAUDE.md
│
└── apps/
    ├── CLAUDE.md                      # Level 2: Category (all apps overview)
    │
    ├── web/                           # Level 3: Runtime Tier - WEB/FRONTEND
    │   ├── CLAUDE.md                  # Frontend tier docs (refs claude/frontend/)
    │   ├── docs/                      # Next.js docs app
    │   │   └── CLAUDE.md
    │   └── web-client/                # Next.js example client
    │       └── CLAUDE.md
    │
    ├── node/                          # Level 3: Runtime Tier - NODE/BACKEND
    │   ├── CLAUDE.md                  # Backend tier docs
    │   ├── trpc-api/                  # tRPC API example
    │   │   ├── CLAUDE.md
    │   │   └── sectors/
    │   │       └── iam/
    │   │           └── CLAUDE.md      # Level 5: Leaf
    │   ├── rest-api/                  # REST API example
    │   │   └── CLAUDE.md
    │   ├── gql-api/                   # GraphQL API example
    │   │   └── CLAUDE.md
    │   └── tgql-api/                  # TypeGraphQL API example
    │       └── CLAUDE.md
    │
    └── core/                          # Level 3: Runtime Tier - AGNOSTIC (if needed)
        └── CLAUDE.md
```

**Hierarchy Visualization:**
```
Level 1: /CLAUDE.md (Root - repo-wide)
    │
    ├── Level 2: /packages/CLAUDE.md (Category)
    │       │
    │       ├── Level 3: /packages/web/CLAUDE.md (Runtime Tier: Web/Browser)
    │       │       └── Level 4: /packages/web/ui/CLAUDE.md (Project)
    │       │
    │       ├── Level 3: /packages/node/CLAUDE.md (Runtime Tier: Node.js)
    │       │       └── Level 4: /packages/node/api-core/CLAUDE.md (Project)
    │       │
    │       └── Level 3: /packages/core/CLAUDE.md (Runtime Tier: Agnostic)
    │               └── Level 4: /packages/core/config/CLAUDE.md (Project)
    │
    └── Level 2: /apps/CLAUDE.md (Category)
            │
            ├── Level 3: /apps/web/CLAUDE.md (Runtime Tier: Web/Frontend)
            │       └── Level 4: /apps/web/docs/CLAUDE.md (Project)
            │
            ├── Level 3: /apps/node/CLAUDE.md (Runtime Tier: Node/Backend)
            │       └── Level 4: /apps/node/trpc-api/CLAUDE.md (Project)
            │               └── Level 5: /apps/node/trpc-api/sectors/iam/CLAUDE.md (Leaf)
            │
            └── Level 3: /apps/core/CLAUDE.md (Runtime Tier: Agnostic)
```

### Cross-Repo References

Since thrive and coach depend on soa, their CLAUDE.md files can reference soa:

```markdown
## Shared Infrastructure

This project uses infrastructure from [saga-soa](~/dev/soa):
- See [soa/docs/architecture.md](~/dev/soa/docs/architecture.md) for core patterns
- See [soa/docs/conventions.md](~/dev/soa/docs/conventions.md) for coding standards
```

### Goals Mapping

| Goal | Implementation |
|------|----------------|
| Strict ESM first | Document in `docs/conventions.md`, mark violations with ⚠️ |
| TypeScript with tsc/tsup | Document in root CLAUDE.md tech stack |
| Vitest testing | Document in `docs/testing.md`, create ADR |
| ESLint (not Prettier) | Document in `docs/conventions.md` |
| Amplify/ECS deployment | Document in `docs/deployment.md` |
| Progressive disclosure | Use hierarchy + docs/ directory |

---

## Future Implementation Plan (For Reference)

When ready to implement, follow these phases:

### Phase 1: Infrastructure Setup (soa)
1. Create `claude/skills/documentation-system/` with adapted scripts/templates
2. Create runtime-specific templates:
   - `claude-md-tier-web.md` - Frontend tier template
   - `claude-md-tier-node.md` - Backend tier template
   - `claude-md-frontend.md` - Frontend app template
   - `claude-md-backend.md` - Backend app template
3. Create `claude/skills/testing/` with auto-detection triggers
4. Create `docs/` directory structure at root
5. Create `decisions/` directory with README.md template

### Phase 2: Root and Category Levels (soa)
1. Refactor `/CLAUDE.md` to follow template (keep under 500 tokens)
2. Create `/docs/architecture.md`, `/docs/development.md`, `/docs/conventions.md`
3. Create `/packages/CLAUDE.md` (Level 2: Category)
4. Create `/apps/CLAUDE.md` (Level 2: Category)

### Phase 3: Runtime Tier Level (soa)
1. Create `/apps/web/CLAUDE.md` (Level 3: Frontend tier)
   - Document: Browser runtime, Vite build, Amplify deployment, client-side auth
2. Create `/apps/node/CLAUDE.md` (Level 3: Backend tier)
   - Document: Node.js runtime, Docker build, ECS deployment, server-side auth

### Phase 4: Project Level (soa)
1. Create CLAUDE.md for core packages (api-core, pubsub-*, db)
2. Create CLAUDE.md for backend apps using `claude-md-backend.md` template
3. Create CLAUDE.md for frontend apps using `claude-md-frontend.md` template

### Phase 5: Validation Infrastructure
1. Add GitHub Actions workflow for documentation validation
2. Port validation scripts from nimbee PR 7876

### Phase 6: Testing Documentation (Placeholder)
**Note**: Testing documentation will be placeholder only until pair session with test engineer.

1. Create `claude/testing/README.md` with placeholder content:
   - Mark as "PLACEHOLDER - Pending test engineer pair session"
   - List questions to resolve (see "Questions for Test Engineer Pair Session" section)
2. Do NOT document testing patterns until decisions made on:
   - Database testing strategy (in-memory vs Docker)
   - Test labeling system
   - Test data builders
   - BDD support
3. After pair session: Update with agreed-upon patterns

### Phase 7: Cross-Repo Setup (thrive, coach)
1. Create root CLAUDE.md with references to soa
2. Create `/apps/web/CLAUDE.md` and `/apps/node/CLAUDE.md` tier docs
3. Create project-specific claude/ with deviations from soa

---

## Resolved Questions

### Skills and Context Loading (DECIDED)

**Approach**: Auto-detect from files + slash command fallback

This enables progressive disclosure:
- When editing files in `tests/` or `__tests__/` → auto-load testing context
- When editing files in `deploy/` or CI configs → auto-load deployment context
- Slash commands (`/testing`, `/deploy`) as fallback when auto-detection doesn't apply
- Base CLAUDE.md always loaded, additional context layered as needed

**Implementation Pattern:**
```
claude/
├── skills/
│   ├── testing/
│   │   ├── SKILL.md           # Auto-loaded when in test directories
│   │   └── triggers.json      # File patterns that trigger this skill
│   ├── deployment/
│   │   └── SKILL.md
│   └── documentation-system/
│       └── SKILL.md
└── commands/
    ├── testing.md             # Slash command fallback: /testing
    └── deploy.md              # Slash command fallback: /deploy
```

### Cross-Repo Dependencies (DECIDED)

**Approach**: soa as source of truth, others reference

```markdown
# In thrive/CLAUDE.md or coach/CLAUDE.md:

## Shared Infrastructure

Uses [saga-soa](../soa) infrastructure. See:
- [soa/docs/architecture.md](../soa/docs/architecture.md) - Core patterns
- [soa/docs/conventions.md](../soa/docs/conventions.md) - Coding standards
- [soa/docs/testing.md](../soa/docs/testing.md) - Testing approach
```

### Questions for Test Engineer Pair Session

The following questions should be discussed with test engineers:

**1. Database Testing Strategy:**
- SOA uses `mongodb-memory-server` (in-memory)
- saga_api uses real Docker containers (MySQL + MongoDB with replica sets)
- **Question**: Should SOA adopt Docker-based testing for more production-realistic integration tests?
- **Trade-off**: In-memory is faster but less realistic; Docker is slower but catches more issues

**2. Test Labeling System:**
- SOA: Directory-based organization (`unit/`, `integration/`)
- saga_api: Tag-based labels (`[smoke]`, `[acceptance]`, `[regression]`, `[unstable]`)
- **Question**: Should SOA adopt tag-based labels for CI pipeline flexibility?
- **Trade-off**: Tags allow selective test runs but add annotation overhead

**3. Test Data Builders:**
- SOA: Direct instantiation of test data
- saga_api: Fishery factories + BaseBuilder pattern with auto-registry
- **Question**: Should SOA adopt builder/factory patterns for test data?
- **Trade-off**: Builders reduce boilerplate but add abstraction layer

**4. Test Isolation:**
- SOA: Per-test mocking with vi.mock()
- saga_api: Per-test/worker isolated databases with unique naming
- **Question**: What isolation level is appropriate for SOA integration tests?

**5. BDD Support:**
- SOA: None
- saga_api: jest-cucumber with Gherkin feature files
- **Question**: Is BDD valuable for SOA, or is code-first testing sufficient?

**6. Test Context/Scope:**
- SOA: Direct service instantiation via DI containers
- saga_api: `TestScope` abstraction with helpers, builders, counters
- **Question**: Should SOA adopt a test context abstraction?

---

## Verification Plan

1. **Token Budget**: Run `validate_tokens.sh` on all CLAUDE.md files
2. **Link Validation**: Run `validate_links.sh` to check all references
3. **Structure Validation**: Ensure required sections present
4. **Manual Testing**: Navigate codebase with Claude Code, verify context is appropriate
5. **Progressive Disclosure**: Verify detailed info is in claude/ or docs/, not CLAUDE.md

---

## Deliverables from This Research

### 1. This Document
- Complete analysis of PR 7876 approach
- Adaptation recommendations for soa/thrive/coach
- Testing differences enumerated for pair session
- Progressive disclosure approach defined

### 2. Key Files from PR 7876 for Reference

Located at `~/dev/nimbee` (on PR 7876 branch):
- `.claude/skills/documentation-system/SKILL.md` - Main skill documentation
- `.claude/skills/documentation-system/templates/claude-md-project.md` - Project template
- `.claude/skills/documentation-system/templates/claude-md-leaf.md` - Leaf template
- `.claude/skills/documentation-system/scripts/validate_tokens.sh` - Token validation
- `.claude/skills/documentation-system/guides/when-to-document.md` - Decision guide
- `.github/workflows/validate-documentation.yml` - CI validation
- `CLAUDE_MD_HIERARCHY_PLAN.md` - Full hierarchy plan (906 lines)

### 3. Testing Comparison Summary

For the pair session, key saga_api test files to review:
- `/home/skelly/dev/nimbee/edu/js/app/saga_api/tests/framework/utils/test_utilities.ts`
- `/home/skelly/dev/nimbee/edu/js/app/saga_api/tests/framework/utils/test_scope.ts`
- `/home/skelly/dev/nimbee/edu/js/app/saga_api/tests/jest.setup.ts`

---

## Next Steps

1. **Review this research document** with stakeholders
2. **Conduct pair session with test engineers** using questions above
3. **Decide on testing approach** (Docker vs in-memory, labels, builders)
4. **Begin implementation** following Future Implementation Plan above
5. **Start with soa**, then extend to thrive/coach with references

---

## Appendix: PR 7876 Token Budget Guidelines

From Anthropic's guidance (as documented in PR 7876):

- **Target**: ~500 tokens (~375 words)
- **Maximum**: 1000 tokens (~750 words)
- **Token calculation**: words × 4/3 (rough estimate)
- **Progressive disclosure**: Extract details to `docs/` when over budget
- **Validation**: Run `validate_tokens.sh` in CI
