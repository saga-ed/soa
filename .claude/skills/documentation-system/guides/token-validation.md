# Token Budget Validation

This guide explains how to manage and validate token budgets for CLAUDE.md files.

## Token Budget Rules

### Target Budget
- **500 tokens** per file (~375 words, ~150 lines)
- This is the ideal target for most CLAUDE.md files

### Maximum Budget
- **1000 tokens** per file (~750 words, ~300 lines)
- Files up to 1000 tokens are acceptable
- Beyond 1000 tokens requires refactoring

### Calculation
- **1 token ≈ 0.75 words** (English text)
- **500 tokens ≈ 375 words**
- **1000 tokens ≈ 750 words**

## Status Indicators

- ✅ **Good** (≤800 tokens) - Within strict budget
- 🟡 **Acceptable** (801-1000 tokens) - Within maximum budget
- ⚠️ **Over Budget** (>1000 tokens) - Requires refactoring

## Validating Token Counts

### Option 1: Use the Validation Script

```bash
# Validate a single file
.claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md

# Validate all CLAUDE.md files
.claude/skills/documentation-system/scripts/validate_tokens.sh
```

The script will show:
- File path
- Word count
- Estimated token count
- Status (✅, 🟡, or ⚠️)

### Option 2: Manual Calculation

```bash
# Count words
wc -w < CLAUDE.md

# Calculate tokens (multiply by 4/3)
words=$(wc -w < CLAUDE.md)
tokens=$((words * 4 / 3))
echo "$tokens tokens"
```

### Option 3: Quick Check

```bash
# Quick visual check - should be under 300 lines
wc -l CLAUDE.md
```

## What to Do When Over Budget

### Step 1: Identify Large Sections

Look for sections that could be extracted:
- Long code examples
- Detailed command explanations
- Extensive lists
- In-depth explanations
- Multiple workflow examples

### Step 2: Extract to docs/

**Before (in CLAUDE.md):**
```markdown
## Build Commands

### Using pnpm
Install pnpm globally: `npm install -g pnpm`
Initialize workspace: `pnpm init`
Install dependencies: `pnpm install`
...
[300 words of build details]

### Using nx
Install nx: `npm install -g nx`
...
[200 words of nx details]
```

**After (in CLAUDE.md):**
```markdown
## Command Discovery

**⚠️ Use pnpm, NOT npm or yarn!**

```bash
pnpm install
npx nx build <project>
pnpm test
```

For comprehensive build commands, see [docs/development.md](./docs/development.md).
```

**After (in docs/development.md):**
```markdown
# Development Guide

## Build Commands

### Using pnpm
[All the detailed content moved here]

### Using nx
[All the detailed content moved here]

...
```

### Step 3: Condense Content

**Techniques:**

1. **Use bullet points instead of paragraphs**
   ```markdown
   <!-- Before: 50 words -->
   This project uses TypeScript with strict mode enabled. We compile
   to ES2020 target for modern Node.js compatibility. The project also
   uses ESLint for code quality and Prettier for formatting.

   <!-- After: 15 words -->
   - **TypeScript** with strict mode
   - **Target**: ES2020 (Node.js)
   - **Linting**: ESLint + Prettier
   ```

2. **Remove redundant information**
   ```markdown
   <!-- Before -->
   ## Testing
   This project uses Jest for testing. Jest is a JavaScript testing
   framework. We use Jest because it's fast and has good TypeScript
   support.

   <!-- After -->
   ## Testing
   - **Framework**: Jest (fast, TypeScript support)
   ```

3. **Link instead of explaining**
   ```markdown
   <!-- Before: 100 words explaining how to run tests -->
   ## Testing
   To run tests, you first need to install dependencies...
   [Long explanation]

   <!-- After -->
   ## Testing
   ```bash
   pnpm test           # All tests
   pnpm test:watch     # Watch mode
   ```

   See [docs/testing.md](./docs/testing.md) for detailed testing guide.
   ```

4. **Combine related sections**
   ```markdown
   <!-- Before: 3 separate sections -->
   ## Build
   [Build info]

   ## Test
   [Test info]

   ## Deploy
   [Deploy info]

   <!-- After: 1 section -->
   ## Command Discovery

   **Quick reference:**
   ```bash
   pnpm build
   pnpm test
   pnpm deploy
   ```

   See [docs/development.md](./docs/development.md) for all commands.
   ```

### Step 4: Validate Again

After refactoring, run the validation script again:
```bash
.claude/skills/documentation-system/scripts/validate_tokens.sh path/to/CLAUDE.md
```

## Common Over-Budget Sections

### 1. Command Lists

**Problem:** Listing every possible command
**Solution:** Show 3-5 key commands, link to full reference

```markdown
<!-- Over-budget -->
## Commands

Build with options:
- `pnpm build` - Production build
- `pnpm build:dev` - Development build
- `pnpm build:watch` - Watch mode
- `pnpm build:clean` - Clean build
[20 more commands...]

<!-- Within budget -->
## Command Discovery

```bash
pnpm build    # Production build
pnpm test     # Run tests
pnpm dev      # Development mode
```

See [docs/development.md](./docs/development.md) for all commands.
```

### 2. Code Examples

**Problem:** Multiple detailed code examples
**Solution:** Show one concise example, link to more

```markdown
<!-- Over-budget -->
## Examples

Creating a user:
```typescript
// Example with all options
const user = await createUser({
  email: 'user@example.com',
  firstName: 'John',
  lastName: 'Doe',
  // ... 20 lines
});
```

[3 more full examples]

<!-- Within budget -->
## Common Workflows

```typescript
// Create user
const user = await createUser({ email, firstName, lastName });
```

See [docs/examples.md](./docs/examples.md) for more examples.
```

### 3. Architecture Explanations

**Problem:** Deep architectural details
**Solution:** Brief overview, link to architecture doc

```markdown
<!-- Over-budget -->
## Architecture

This system uses a layered architecture with clear separation
of concerns. The presentation layer handles HTTP requests...
[500 words of architecture]

<!-- Within budget -->
## Project Structure

```
src/
├── api/        # HTTP routes
├── services/   # Business logic
└── data/       # Database access
```

See [docs/architecture.md](./docs/architecture.md) for design details.
```

### 4. Convention Details

**Problem:** Explaining every convention
**Solution:** Highlight deviations, link to full conventions

```markdown
<!-- Over-budget -->
## Conventions

We use snake_case for variables. Here's why: [explanation]
We use PascalCase for types. Here's why: [explanation]
We import in this order: [explanation]
[10 more conventions]

<!-- Within budget -->
## Convention Deviations

**⚠️ Uses snake_case in TypeScript!**

```typescript
// ✅ Correct
const user_id = "123";

// ❌ Incorrect
const userId = "123";
```

See [docs/conventions.md](./docs/conventions.md) for all conventions.
```

## Budget by File Type

Different levels have different expectations:

| Level | Typical Size | Acceptable Max | Notes |
|-------|--------------|----------------|-------|
| Root | 400-600 words | 800 words | Keep very concise |
| Domain | 500-700 words | 900 words | Overview level |
| Tier | 500-800 words | 1000 words | May need more detail |
| Project | 500-800 words | 1000 words | Balance overview/detail |
| Leaf | 600-900 words | 1100 words | Most detailed level |

## Validation Checklist

Before finalizing a CLAUDE.md file:

- [ ] Run validation script
- [ ] Token count ≤ 1000
- [ ] If 800-1000 tokens, can anything be extracted?
- [ ] All code examples are concise
- [ ] No redundant information
- [ ] Links to detailed docs for verbose content
- [ ] Bullet points used instead of paragraphs where possible
- [ ] Only essential commands shown
- [ ] Convention deviations called out explicitly
- [ ] Documentation directive included

## Maintenance

### When to Revalidate

Revalidate token counts when:
- Adding new sections
- Updating existing content
- Merging changes from multiple contributors
- During quarterly documentation review

### Progressive Budgeting

As the documentation system matures:
1. **Month 1**: Get all files under 1000 tokens
2. **Month 3**: Get all files under 800 tokens
3. **Month 6**: Get all files under 600 tokens (ideal)

## Tools

### Validation Script

Location: `.claude/skills/documentation-system/scripts/validate_tokens.sh`

Usage:
```bash
# Single file
./validate_tokens.sh path/to/CLAUDE.md

# All files
./validate_tokens.sh

# With verbose output
./validate_tokens.sh -v
```

### Word Count

```bash
# Words
wc -w CLAUDE.md

# Lines
wc -l CLAUDE.md

# Characters
wc -c CLAUDE.md
```

## FAQ

**Q: My file is at 850 tokens. Do I need to refactor?**
A: Not necessarily. 850 tokens is acceptable (🟡). But if you're adding more content, consider extracting some details first.

**Q: Can I just ignore the budget for critical information?**
A: No. If information is critical, keep a summary in CLAUDE.md and put full details in docs/. The budget ensures files stay navigational.

**Q: What if I have a very complex component?**
A: Complex components need more detailed docs/, not longer CLAUDE.md. Keep CLAUDE.md as a navigation entry point.

**Q: Is 500 tokens a hard limit?**
A: No, it's a target. Acceptable range is 400-1000 tokens. Aim for 500, accept up to 1000.

---

*Remember: CLAUDE.md is a navigation file, not a complete reference. Keep it concise!*
