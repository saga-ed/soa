# Maintaining Documentation

This guide explains how to keep the hierarchical CLAUDE.md system up-to-date and healthy.

## Regular Maintenance Tasks

### Monthly: Token Budget Review

Run validation on all files:
```bash
.claude/skills/documentation-system/scripts/validate_tokens.sh
```

**If any files are over budget:**
1. Review the oversized file
2. Extract details to docs/
3. Update links in CLAUDE.md
4. Revalidate

### Quarterly: Link Validation

Check all internal links:
```bash
# Find all CLAUDE.md files
find . -name "CLAUDE.md" -type f

# For each file, verify linked files exist
# (Manual check or create automated script)
```

**Fix broken links immediately.**

### Quarterly: Content Freshness Review

Review for outdated information:
- Version numbers (Node.js, Ruby, dependencies)
- Build commands (if tools changed)
- Deployment procedures (if changed)
- Convention deviations (still applicable?)

**Update "Last updated" date** at bottom of file.

## Updating Existing Documentation

### When to Update

Update CLAUDE.md when:
- Major architectural changes
- Convention changes
- New critical dependencies
- Breaking changes
- Security updates
- Discovered critical gotchas

Don't update for:
- Implementation details
- Bug fixes (unless they expose patterns)
- Cosmetic changes
- Temporary workarounds

### How to Update

1. **Read the file first**
   ```bash
   cat path/to/CLAUDE.md
   ```

2. **Make targeted changes**
   - Only update affected sections
   - Keep other content unchanged
   - Maintain existing structure

3. **Check token budget**
   ```bash
   .claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md
   ```

4. **If over budget, extract details**
   - Move verbose content to docs/
   - Keep summary in CLAUDE.md
   - Add link to detailed docs

5. **Update "Last updated" date**
   ```markdown
   *Target: ~500 tokens | Last updated: 2026-01-17*
   ```

6. **Commit with descriptive message**
   ```bash
   git add path/to/CLAUDE.md
   git commit -m "Update CLAUDE.md: [description of change]"
   ```

## Refactoring Oversized Files

### Process

1. **Identify large sections**
   - Command lists (more than 5-7 commands)
   - Code examples (more than 1-2 examples)
   - Architecture explanations (more than 3-4 paragraphs)
   - Convention details (anything beyond deviations)

2. **Create or update docs/ file**
   ```bash
   mkdir -p path/to/project/docs
   # Create or update docs/[topic].md
   ```

3. **Move detailed content**
   - Copy full content to docs/ file
   - Organize with headings
   - Add examples, details, explanations

4. **Replace in CLAUDE.md with summary + link**
   ```markdown
   ## [Section]

   [Brief 2-3 line summary]

   For details, see [docs/[topic].md](./docs/[topic].md).
   ```

5. **Validate new token count**
   ```bash
   .claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md
   ```

### Example Refactoring

**Before (CLAUDE.md, 1200 tokens):**
```markdown
## Build Commands

### Using pnpm
pnpm is a fast, disk space efficient package manager...
[200 words]

### Using nx
Nx is a build system with caching...
[200 words]

### Using bit.js
bit.js is our legacy build system...
[200 words]

[More build details...]
```

**After (CLAUDE.md, 600 tokens):**
```markdown
## Command Discovery

**⚠️ Use pnpm, NOT npm or yarn!**

```bash
pnpm install
npx nx build <project>
pnpm test
```

For comprehensive build/test/deploy commands, see [docs/development.md](./docs/development.md).
```

**After (docs/development.md):**
```markdown
# Development Guide

## Build Commands

### Using pnpm
[Full 200 word explanation]

### Using nx
[Full 200 word explanation]

### Using bit.js
[Full 200 word explanation]

[All additional build details]
```

## Keeping Navigation Synchronized

### When Adding New Projects

1. **Create child CLAUDE.md** with Parent Context
2. **Update parent CLAUDE.md** to list new child
3. **Check paths are correct** (relative paths)
4. **Verify links work**

### When Renaming

1. **Update the file** (rename CLAUDE.md if needed - usually just content)
2. **Find all references**:
   ```bash
   grep -r "old_name" . --include="*.md"
   ```
3. **Update all parent references** to new name
4. **Update all sibling references** if any

### When Moving

1. **Move the CLAUDE.md file** to new location
2. **Update its Parent Context** (path likely changed)
3. **Update old parent** (remove from listing)
4. **Update new parent** (add to listing)
5. **Update all relative paths** in the moved file
6. **Check all links** still work

## Handling Convention Changes

### When Conventions Change

1. **Create or update ADR** documenting the change
   ```bash
   cp .claude/skills/documentation-system/templates/adr-template.md \
      decisions/NNN-new-convention.md
   ```

2. **Update CLAUDE.md Convention Deviations**
   - Add new deviation with ⚠️
   - Update code examples
   - Link to ADR

3. **Update docs/conventions.md** with full details

4. **Consider deprecation note** for old convention
   ```markdown
   **⚠️ Deprecated:** Old convention no longer used. See ADR NNN.
   ```

### Example

**New convention:** Switching from Jest to Vitest

1. **Create ADR:**
   ```markdown
   # ADR 003: Migrate from Jest to Vitest
   [Full decision documentation]
   ```

2. **Update CLAUDE.md:**
   ```markdown
   ## Convention Deviations

   **⚠️ Uses Vitest, not Jest:**
   - Test files use `*.test.ts` pattern
   - Configuration in `vitest.config.ts`
   - See `decisions/003-migrate-to-vitest.md`

   ## Tech Stack

   - **Testing**: Vitest (migrated from Jest)
   ```

3. **Update docs/development.md:**
   ```markdown
   # Development Guide

   ## Testing

   We use Vitest for testing...
   [Full migration guide, examples, etc.]
   ```

## Deprecating Documentation

### When Component is Deprecated

1. **Add deprecation notice** at top of CLAUDE.md:
   ```markdown
   # [Component Name]

   **⚠️ DEPRECATED:** This component is deprecated and will be removed in [version/date].
   See [replacement component](../replacement/CLAUDE.md) for migration.

   > [Original tagline]
   ```

2. **Update parent CLAUDE.md**:
   ```markdown
   **Deprecated:**
   - `old_component/` - ⚠️ Deprecated, use [new_component](./new_component/CLAUDE.md)
   ```

3. **Keep file in place** (don't delete immediately)

4. **After removal, delete file** and update parent

## Merging Documentation Updates

### When Multiple People Update

1. **Review all changes**:
   ```bash
   git diff main path/to/CLAUDE.md
   ```

2. **Check for conflicts** in token budget
   - If both added content, may be over budget
   - May need to consolidate

3. **Validate after merge**:
   ```bash
   .claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md
   ```

4. **Refactor if needed** to stay within budget

## Common Maintenance Scenarios

### Scenario 1: Adding a Major Feature

**Do:**
- Add brief mention in CLAUDE.md Key Features
- Create detailed docs/[feature].md
- Update Common Workflows if needed

**Don't:**
- Add full feature documentation to CLAUDE.md
- List every new function/endpoint

### Scenario 2: Changing Database

**Do:**
- Create ADR documenting decision
- Update Tech Stack in CLAUDE.md
- Update Convention Deviations if patterns change
- Update docs/architecture.md with full details
- Update docs/development.md with new setup

**Don't:**
- Just change Tech Stack without ADR
- Add full migration guide to CLAUDE.md

### Scenario 3: Refactoring Project Structure

**Do:**
- Update Project Structure diagram in CLAUDE.md
- Update all affected navigation links
- Create docs/architecture.md explaining new structure

**Don't:**
- Explain every file move in CLAUDE.md
- Leave broken links

## Maintenance Checklist

**When making changes:**

- [ ] Changes are actually needed (see when-to-document.md)
- [ ] Token budget checked before and after
- [ ] Over-budget content extracted to docs/
- [ ] Links still work
- [ ] Parent/child navigation updated if needed
- [ ] "Last updated" date updated
- [ ] Commit message is descriptive

**Monthly:**

- [ ] Run token validation on all files
- [ ] Review any over-budget files
- [ ] Check for obviously outdated information

**Quarterly:**

- [ ] Full link validation
- [ ] Review version numbers and commands
- [ ] Check convention deviations still apply
- [ ] Verify ADRs are still current

## Automation Ideas

### Validation Script

Already provided: `.claude/skills/documentation-system/scripts/validate_tokens.sh`

### Link Checker

Could create:
```bash
# validate_links.sh
# Check all markdown links in CLAUDE.md files
```

### Staleness Checker

Could create:
```bash
# check_staleness.sh
# Find files not updated in > 6 months
# Report for review
```

## Getting Help

If unsure about maintenance:
1. Read `SKILL.md` for overall guidance
2. Check `guides/when-to-document.md` for what to update
3. Check existing CLAUDE.md files for patterns
4. Ask team for review before major changes

---

*Keep documentation fresh, concise, and navigable.*
