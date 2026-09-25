# Phase 3 Detailed Plan: Thrive SOA Infrastructure Merge

## Executive Summary

The `gh_t54` branch in thrive represents a **significant architectural reorganization** beyond simple SOA package updates. This merge is considerably more complex than coach (Phase 2) due to:

1. **Structural restructuring**: Apps moved to `apps/node/` and `apps/web/` tiers
2. **Package consolidation**: Elimination of `thrive-auth` and `thrive-s3` as standalone packages
3. **New development workflow**: Multiple specialized scripts replacing monolithic `setup-dev.sh`
4. **Data system dependencies**: PostgreSQL and OpenFGA with health checks and migrations
5. **SOA linking support**: New `soa-link.json` for local development workflow

**Change Scope**: 136 files changed (+2,245 / -7,091 lines)

**Prerequisites**: ✅ **Phase 1 Complete** - SOA merged to main and all `@saga-ed/*` packages published to saga_js CodeArtifact

**User Decisions**:
- ✅ Keep modular shell script approach (no migration to pnpm scripts/make)
- ✅ Include ARES test reorganization (similar to coach Phase 2)
- ✅ Fix all test failures before merge (no documentation-only approach)

---

## Current State Analysis

### Main Branch (Current Production)

**Structure:**
```
thrive/
├── apps/
│   ├── transcripts-api/          # Backend API
│   ├── deidentification-api/     # Backend API
│   └── dev-client/               # SvelteKit frontend
├── packages/
│   ├── thrive-broker/            # RabbitMQ utilities
│   ├── thrive-auth/              # Auth middleware (REMOVED in gh_t54)
│   └── thrive-s3/                # S3 utilities (REMOVED in gh_t54)
└── scripts/
    └── setup-dev.sh              # Monolithic setup script
```

**Dependencies:**
- No `.npmrc` (uses default npm registry)
- No `soa-link.json` (no local linking capability)
- Direct npm imports of `@saga-ed` packages (hardcoded versions)

**Setup Process**: Single `setup-dev.sh` script with 6 sequential steps:
1. Copy `.env.example` → `.env` for all apps
2. Start Docker containers (postgres + openfga)
3. Install dependencies with `pnpm install`
4. Generate Prisma clients for both APIs
5. Build project with `pnpm build`
6. Run database migrations (`db:migrate`)
7. Execute test suite

### gh_t54 Branch (Target State)

**Structure:**
```
thrive/
├── apps/
│   ├── node/                     # Backend tier
│   │   ├── transcripts-api/
│   │   └── deidentification-api/
│   └── web/                      # Frontend tier
│       └── dev-client/
├── packages/
│   └── node/                     # Node.js tier
│       └── thrive-broker/
├── scripts/                      # NEW: Modular scripts
│   ├── quick-start.sh           # Complete from-scratch setup
│   ├── dev-setup.sh             # Switch local/CI mode
│   ├── docker-init.sh           # Docker-specific setup
│   ├── validate-setup.sh        # Environment verification
│   └── switch-saga-soa-deps.sh  # Toggle local/published packages
└── soa-link.json                # NEW: Local SOA linking config
```

**Key Changes:**
1. **Registry Configuration**: `.npmrc` points to `saga_js` CodeArtifact
2. **SOA Linking**: `soa-link.json` defines 5 linked packages:
   - `@saga-ed/soa-api-core` → `packages/node/api-core`
   - `@saga-ed/soa-config` → `packages/core/config`
   - `@saga-ed/soa-db` → `packages/node/db`
   - `@saga-ed/soa-logger` → `packages/node/logger`
   - `@saga-ed/soa-rabbitmq` → `packages/node/rabbitmq`
3. **Package Consolidation**:
   - `thrive-auth` code moved into `transcripts-api` and `deidentification-api` directly
   - `thrive-s3` utilities integrated into `transcripts-api/src/utils/s3.ts`
4. **Enhanced Scripts**: Prerequisite checking, authentication management, validation

---

## Data System Dependencies

### PostgreSQL (4 Databases)

**Container**: `thrive-postgres` (PostgreSQL 16)
- `transcripts` - Transcripts API data
- `deidentification` - Deidentification API data
- `openfga` - Authorization data
- `auth` - Auth service data

**Health Check**: Enabled with `pg_isready` probe

**Prisma Setup**:
- 2 separate Prisma schemas (one per API app)
- Migration workflow: `pnpm db:generate` → `pnpm build` → `pnpm db:migrate`
- **Critical**: Prisma client generation MUST occur before TypeScript compilation

### OpenFGA (Authorization Service)

**Container**: `thrive-openfga`
- Uses PostgreSQL as datastore (not in-memory)
- Playground on port 3005
- gRPC on 8081, HTTP on 8080
- **Dependency**: Requires PostgreSQL to be healthy first

### Docker Compose Orchestration

**Current Setup** (main branch):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    healthcheck: pg_isready
  openfga:
    image: openfga/openfga:latest
    depends_on:
      postgres: { condition: service_healthy }
```

**Best Practice**: Already using health checks and dependency ordering

---

## Detailed Merge Plan

### Phase 3.0: Pre-Merge Validation

**Goal**: Ensure environment is ready for merge

```bash
cd /home/skelly/dev/thrive

# Verify current branch
git status
git branch -a

# Ensure main is up-to-date
git checkout main
git pull origin main

# Verify Docker services are stopped
docker compose down

# Verify no pending changes
git status --porcelain
```

**Gate**: Clean working directory, main branch up-to-date

---

### Phase 3.1: Create Fresh Branch & Squash Merge

```bash
cd /home/skelly/dev/thrive
git checkout main
git checkout -b update/soa-infrastructure
git merge --squash gh_t54
```

**Review Before Commit**:
- Check `git diff --staged --stat` for expected file changes
- Verify critical files:
  - `soa-link.json` added
  - `.npmrc` added
  - `scripts/` directory reorganized
  - `apps/` restructured into node/web tiers
  - `packages/thrive-auth/` and `packages/thrive-s3/` removed

```bash
git commit -m "SOA infrastructure alignment: app/package restructuring, saga_js registry, cross-repo linking, consolidated auth/S3 utilities"
```

**Gate**: Merge committed locally, no push yet

---

### Phase 3.2: Environment Setup & Docker Validation

**Goal**: Ensure data systems are operational

#### Step 1: Validate Docker Compose Configuration

```bash
cd /home/skelly/dev/thrive

# Validate docker-compose.yml syntax
docker compose config

# Start services in foreground (watch for errors)
docker compose up
```

**Expected Output**:
- PostgreSQL starts and reports "database system is ready"
- OpenFGA waits for PostgreSQL health check
- OpenFGA starts successfully after PostgreSQL is healthy

#### Step 2: Verify Database Initialization

```bash
# In another terminal
docker exec thrive-postgres psql -U saga_user -l

# Expected: 4 databases listed
#  - transcripts
#  - deidentification
#  - openfga
#  - auth
```

#### Step 3: Verify OpenFGA Connectivity

```bash
# Check OpenFGA health
curl http://localhost:8080/healthz

# Expected: {"status":"SERVING"}
```

**Gate**: All Docker services healthy and accessible

---

### Phase 3.3: Build & Test (link:off) - Published Packages

**Goal**: Validate against published `@saga-ed/*` packages from `saga_js`

#### Step 1: Configure for Published Packages

```bash
cd /home/skelly/dev/thrive

# Ensure soa-link is OFF (if soa:link:off script exists, otherwise verify manually)
# The new gh_t54 scripts may have different names - check scripts/ directory
ls -la scripts/

# If switch-saga-soa-deps.sh exists:
./scripts/switch-saga-soa-deps.sh published

# Otherwise, verify .npmrc points to CodeArtifact (already in gh_t54)
cat .npmrc
```

#### Step 2: Clean Install

```bash
# Remove existing node_modules and lock file to ensure clean state
rm -rf node_modules apps/*/node_modules packages/*/node_modules
rm -f pnpm-lock.yaml

# Authenticate with CodeArtifact
pnpm soa:auth
# OR if not available as pnpm script:
aws codeartifact login --tool npm --domain saga --repository saga_js --region us-west-2

# Install dependencies
pnpm install
```

**Expected Issues**:
- May require AWS credentials configuration
- May require `@saga-ed/*` packages to be already published (from Phase 1)

#### Step 3: Generate Prisma Clients

**Critical**: Must happen before build

```bash
# Generate for transcripts-api
cd apps/node/transcripts-api
pnpm db:generate

# Generate for deidentification-api
cd ../deidentification-api
pnpm db:generate

# Return to root
cd ../../..
```

#### Step 4: Build Project

```bash
pnpm build
```

**Potential Issues**:
- Missing `@saga-ed` package versions (indicates Phase 1 publish incomplete)
- Prisma client import errors (indicates `db:generate` failed)
- TypeScript errors from structural changes

#### Step 5: Run Database Migrations

```bash
# Transcripts API migrations
cd apps/node/transcripts-api
pnpm db:migrate

# Deidentification API migrations
cd ../deidentification-api
pnpm db:migrate

cd ../../..
```

**Expected**: Migrations may say "No pending migrations" if already applied

#### Step 6: Type Check

```bash
pnpm typecheck
```

#### Step 7: Run Tests (Initial Run)

```bash
pnpm test
```

**Known Potential Issues**:
- Test coverage requirements are strict (100% on services)
- Integration tests require database to be fully migrated
- Tests may fail due to:
  - Environment configuration differences
  - Missing test data/fixtures
  - API changes in SOA packages
  - Database state issues

**Decision**: Fix all test failures before merge (don't just document)

**Next**: If tests fail, proceed to Phase 3.7 for resolution

---

### Phase 3.4: Build & Test (link:on) - Local SOA Development

**Goal**: Validate local SOA package linking for development workflow

#### Step 1: Switch to Local SOA Dependencies

```bash
cd /home/skelly/dev/thrive

# Verify ../soa exists
ls -la ../soa

# Switch to local mode
./scripts/switch-saga-soa-deps.sh local
# OR if using different script names:
pnpm soa:link:on
```

**Expected Changes**:
- `package.json` files updated with `file:` protocol dependencies
- Example: `"@saga-ed/soa-logger": "file:../../../soa/packages/node/logger"`

#### Step 2: Rebuild with Local Dependencies

```bash
# Clean install with new dependencies
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install

# Rebuild everything
pnpm build
```

**Validation**:
- Verify workspace linking: `pnpm list @saga-ed/soa-api-core`
- Should show path to local soa repository

#### Step 3: Run Tests with Local Dependencies

```bash
pnpm test
```

**Purpose**: Ensures local development workflow functions correctly

**Gate**: Both link:on and link:off builds pass

---

### Phase 3.5: Test Reorganization (ARES Conventions)

**Goal**: Apply ARES testing conventions from `~/dev/soa/claude/testing/`

**Decision**: Include test reorganization (similar to coach Phase 2)

#### Step 1: Inventory Current Tests

```bash
cd /home/skelly/dev/thrive

# Find all test files
find apps packages -name "*.test.ts" -o -name "*.spec.ts"
```

#### Step 2: Apply ARES Naming Conventions

**Convention**: `name.[type].[purpose?].test.ts`

**Rename Pattern**:
- Unit tests: `*.test.ts` → `*.unit.test.ts`
- Integration tests: `*.test.ts` → `*.integration.test.ts`
- E2E tests: `*.test.ts` → `*.e2e.test.ts`

**Key Files to Rename** (based on exploration):
- `apps/node/transcripts-api/src/__tests__/services/transcripts.service.test.ts`
  → `transcripts.service.unit.test.ts`
- `apps/node/deidentification-api/src/__tests__/services/deidentification.service.test.ts`
  → `deidentification.service.unit.test.ts`

**References**:
- `~/dev/soa/claude/testing/conventions.md` — File naming & structure
- `~/dev/soa/claude/testing/philosophy.md` — ARES framework
- `~/dev/soa/claude/testing/builders.md` — Test data patterns

#### Step 3: Verify Test Discovery

```bash
# Ensure Vitest still finds renamed tests
pnpm test --reporter=verbose | grep -E "\.test\.ts"
```

#### Step 4: Update Test Configuration if Needed

Check `vitest.config.ts` files for test pattern matching:
- Ensure `include` patterns match new naming convention
- Typical pattern: `**/*.{test,spec}.{js,ts}`

**Note**: Only reorganize structure, don't fix failing tests yet (that comes in Phase 3.7)

---

### Phase 3.6: Script Validation & Documentation

**Goal**: Validate new script suite

**Decision**: Keep shell scripts as-is (no migration to pnpm scripts or make)

#### Step 1: Test New Scripts

```bash
cd /home/skelly/dev/thrive

# Test validation script
./scripts/validate-setup.sh

# Test docker initialization
docker compose down
./scripts/docker-init.sh

# Verify switch functionality
./scripts/switch-saga-soa-deps.sh --help
```

#### Step 2: Ensure Documentation Exists

Verify `scripts/README.md` exists in gh_t54, or create if missing:

```markdown
# Thrive Scripts

## Setup Scripts

- **quick-start.sh**: Complete environment setup from scratch
- **dev-setup.sh**: Switch between local/CI dependency modes
- **docker-init.sh**: Initialize Docker services
- **validate-setup.sh**: Verify environment is correctly configured
- **switch-saga-soa-deps.sh**: Toggle SOA package source (local vs published)

## Usage Examples

### Initial Setup
\`\`\`bash
./scripts/quick-start.sh
\`\`\`

### Daily Development
\`\`\`bash
# Start with local SOA development
./scripts/switch-saga-soa-deps.sh local
pnpm install
pnpm dev

# Switch to published packages before committing
./scripts/switch-saga-soa-deps.sh published
\`\`\`
```

**Rationale for Keeping Shell Scripts**:
1. Already implemented and tested
2. No additional dependencies required
3. Familiar to development team
4. Easy to debug and modify
5. Clear, linear execution flow

---

### Phase 3.7: Test Failure Resolution

**Goal**: Investigate and fix all test failures

**Decision**: Fix all failures before merge (don't just document)

#### Step 1: Analyze Test Failures

```bash
cd /home/skelly/dev/thrive

# Run tests with verbose output
pnpm test --reporter=verbose 2>&1 | tee test-results.txt

# Identify failure patterns
grep -A 10 "FAIL" test-results.txt
```

**Common Failure Categories**:
1. **Import errors**: SOA package API changes
2. **Type errors**: Updated type definitions
3. **Database errors**: Migration state or connection issues
4. **Mock/stub issues**: Test setup needs updating
5. **Environment variables**: Missing configuration

#### Step 2: Fix Failures by Category

**For Import/API Errors**:
- Review SOA package changelogs
- Update import statements and API calls
- Check for renamed exports or moved modules

**For Type Errors**:
- Update type annotations to match new definitions
- Check for breaking changes in `@saga-ed/*` type exports

**For Database Errors**:
- Verify test Prisma client setup: `apps/node/*/src/__tests__/setup/test-prisma-client.ts`
- Ensure migrations are applied: `pnpm db:migrate`
- Check test database isolation

**For Mock Issues**:
- Update DI container mocks in test setup
- Verify factory patterns still align with code changes

#### Step 3: Rerun Tests After Fixes

```bash
pnpm test
```

**Gate**: All tests must pass before proceeding

#### Step 4: Verify Coverage Requirements

```bash
# Check coverage (if configured)
pnpm test:coverage

# Ensure 100% service coverage maintained (per CLAUDE.md)
```

---

### Phase 3.8: Pre-Push Validation Checklist

**Final Verification Before Creating PR**:

- [ ] Docker services start successfully
- [ ] PostgreSQL has all 4 databases
- [ ] OpenFGA is accessible
- [ ] `pnpm install` succeeds (link:off)
- [ ] Prisma clients generate successfully
- [ ] `pnpm build` succeeds (link:off)
- [ ] Database migrations apply successfully
- [ ] `pnpm typecheck` passes (zero errors)
- [ ] Tests renamed to ARES conventions
- [ ] **All tests pass (link:off)** ← CRITICAL
- [ ] `pnpm install` succeeds (link:on)
- [ ] `pnpm build` succeeds (link:on)
- [ ] **All tests pass (link:on)** ← CRITICAL
- [ ] All new scripts execute without errors
- [ ] `.env` files are in `.gitignore` (not committed)
- [ ] No `file:` dependencies in package.json (link:off before push)
- [ ] Scripts documentation exists (scripts/README.md)

---

### Phase 3.9: Create Pull Request

```bash
cd /home/skelly/dev/thrive

# Switch back to published packages before push
./scripts/switch-saga-soa-deps.sh published
# OR
pnpm soa:link:off

# Verify no file: dependencies remain
grep -r "file:" package.json apps/*/package.json packages/*/package.json || echo "✓ Clean"

# Push branch
git push -u origin update/soa-infrastructure

# Create PR with comprehensive description
gh pr create \
  --title "SOA Infrastructure Alignment & Architectural Modernization" \
  --body "$(cat <<'EOF'
## Summary

Aligns Thrive with SOA infrastructure updates from saga-soa#gh_t54, including:

- 📦 Migrated to saga_js CodeArtifact registry
- 🔗 Added local SOA package linking capability via soa-link.json
- 🏗️ Restructured apps into node/web tiers (apps/node/, apps/web/)
- 🔧 Replaced monolithic setup-dev.sh with modular script suite
- 🎯 Consolidated thrive-auth and thrive-s3 into API apps
- ✅ Validated with both local and published SOA dependencies

## Breaking Changes

- **Directory Structure**: Apps moved from `apps/` to `apps/node/` and `apps/web/`
- **Setup Process**: Use new scripts in `scripts/` directory (see scripts/README.md)
- **Local Development**: Run `./scripts/switch-saga-soa-deps.sh local` for SOA development

## Dependencies

- Requires `@saga-ed/*` packages version ^1.0.4+ from saga_js CodeArtifact
- Requires AWS credentials for CodeArtifact authentication
- Requires saga-soa cloned as sibling directory for local development

## Testing

- ✅ Build passes with published packages (link:off)
- ✅ Build passes with local SOA linking (link:on)
- ✅ Docker services start successfully
- ✅ Database migrations apply cleanly
- ✅ All tests pass (100% pass rate)

## Migration Guide

1. Authenticate with CodeArtifact: `pnpm soa:auth`
2. Run setup: `./scripts/quick-start.sh`
3. For local SOA development: `./scripts/switch-saga-soa-deps.sh local`

## Related

- Follows SOA changes from: [link to SOA PR]
- Part of cross-repo infrastructure update (see saga-soa/claude/projects/gh_t54/plan-merge-update.md)
EOF
)"
```

**Gate**: PR created and ready for review

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Published packages not available | Medium | High | Verify Phase 1 complete before starting |
| Docker services fail to start | Low | High | Pre-validate docker-compose.yml, check ports |
| Prisma migrations fail | Medium | Medium | Review migration files, backup data if needed |
| Test failures block merge | Medium | Medium | Fix all test failures before merge (user requirement) |
| Breaking changes in SOA packages | Low | High | Coordinate with SOA maintainer |
| AWS credential issues | Medium | Low | Document auth requirements, provide fallback |
| Local linking breaks CI | Low | Medium | Verify pre-commit hooks block link:on pushes |

---

## Success Criteria

**All Required (No Compromise)**:
- ✅ Build passes with published packages (link:off)
- ✅ Build passes with local SOA linking (link:on)
- ✅ Type checking passes (zero errors)
- ✅ **All tests pass** (100% pass rate required)
- ✅ Database migrations successful
- ✅ Docker services healthy
- ✅ Tests reorganized per ARES conventions
- ✅ All new scripts validated
- ✅ PR created with documentation

---

## Estimated Complexity

**Compared to Coach (Phase 2)**: **~3x more complex**

**Factors**:
- Structural reorganization (not just dependency updates)
- Data system dependencies (PostgreSQL + OpenFGA)
- Multiple Prisma schemas and migrations
- Package consolidation (code movement)
- New scripting architecture
- More sophisticated local/published switching

**Recommendation**: Allocate 2-3 hours for full execution and validation

---

## Implementation Notes

### Critical Path Dependencies

1. **Docker → Database → Prisma → Build → Test**
   - PostgreSQL must be healthy before OpenFGA starts
   - Prisma clients must generate before TypeScript compilation
   - Database migrations must succeed before integration tests

2. **SOA Packages → Installation → Build**
   - Published `@saga-ed/*` packages must be in saga_js
   - CodeArtifact authentication required for `pnpm install`
   - Local linking (link:on) requires ../soa to be present

### Key Files to Review During Merge

**Configuration:**
- `/home/skelly/dev/thrive/.npmrc` - CodeArtifact registry
- `/home/skelly/dev/thrive/soa-link.json` - Local linking config
- `/home/skelly/dev/thrive/pnpm-workspace.yaml` - Workspace paths
- `/home/skelly/dev/thrive/turbo.json` - Build task dependencies

**Scripts:**
- `/home/skelly/dev/thrive/scripts/quick-start.sh`
- `/home/skelly/dev/thrive/scripts/dev-setup.sh`
- `/home/skelly/dev/thrive/scripts/switch-saga-soa-deps.sh`
- `/home/skelly/dev/thrive/scripts/validate-setup.sh`

**Apps:**
- `/home/skelly/dev/thrive/apps/node/transcripts-api/`
- `/home/skelly/dev/thrive/apps/node/deidentification-api/`
- `/home/skelly/dev/thrive/apps/web/dev-client/`

**Packages:**
- `/home/skelly/dev/thrive/packages/node/thrive-broker/`

### Alternative Verification Commands

If standard scripts fail, use these manual verification steps:

```bash
# Verify Docker services
docker ps --filter name=thrive
docker logs thrive-postgres
docker logs thrive-openfga

# Verify databases
docker exec thrive-postgres psql -U saga_user -c "\l"

# Verify Prisma client generation
ls -la apps/node/transcripts-api/src/prisma/generated/
ls -la apps/node/deidentification-api/src/prisma/generated/

# Check dependency resolution
pnpm list @saga-ed/soa-api-core
pnpm why @saga-ed/soa-logger

# Verify no file: dependencies before push
git diff --cached | grep "file:"
```

---

## Post-Merge Follow-Up Tasks

**Not included in this merge** (defer to separate efforts):

1. **Lambda/IaC Updates**: The `iac/` directory changes may need separate validation
2. **Performance Testing**: RabbitMQ and database performance under load
3. **Security Audit**: Review Auth0 configuration and OpenFGA policies
4. **Documentation**: Update developer onboarding guide with new scripts
5. **CI/CD Pipeline**: Update GitHub Actions for new directory structure

---
