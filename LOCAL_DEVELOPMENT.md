# 🚀 Local Development & CI/CD Checks

## Quick Commands

### Run the Same Checks as CI/CD Locally

```bash
# Check changed packages (like CI/CD does)
pnpm ci:check

# Check all packages (may take longer)
pnpm ci:check:all

# Check a specific package
pnpm ci:check @hipponot/config
node scripts/local-ci-checks.js @hipponot/api-core

# Quick check (just lint, type check, build)
pnpm quick:check @hipponot/config
```

## What These Scripts Do

### Full CI Checks (`pnpm ci:check`)
Runs the exact same checks as GitHub Actions:
1. ✅ **Install dependencies**
2. ✅ **Lint affected packages** (with Turborepo)
3. ✅ **Type check affected packages**
4. ✅ **Build affected packages** (includes dependencies)
5. ✅ **Test affected packages**

### Quick Checks (`pnpm quick:check`)
Runs just the essential checks for fast feedback:
1. ✅ **Lint**
2. ✅ **Type check** 
3. ✅ **Build**

## Example Workflow

### 1. Make changes to a package
```bash
# Edit files in packages/config/
```

### 2. Quick local validation
```bash
pnpm quick:check @hipponot/config
```

### 3. Full CI validation before push
```bash
pnpm ci:check @hipponot/config
```

### 4. Check all changed packages
```bash
pnpm ci:check:changed
```

## Understanding the Output

### ✅ Success Indicators
- **Lint**: No linting errors
- **Type check**: No TypeScript errors
- **Build**: Package builds successfully, creates dist/ files
- **Test**: All tests pass

### ❌ Common Failures & Solutions

#### "Missing tasks in project"
```
x Could not find task `test` in project
```
**Solution**: Add test script to package.json:
```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

#### "Cannot find module '@hipponot/...'"
```
Cannot find module '@hipponot/logger'
```
**Solutions**:
1. Build the dependency first: `pnpm turbo run build --filter=@hipponot/logger`
2. Check package exports in the dependency's package.json
3. Ensure the import path is correct

#### TypeScript errors
```
Block-scoped variable 'CreateProjectSchema' used before its declaration
```
**Solution**: Fix the TypeScript code issues

#### Lint errors
```
'basename' is defined but never used
```
**Solution**: Remove unused imports or prefix with underscore: `_basename`

## Advanced Usage

### Check specific types of issues
```bash
# Just lint all packages
pnpm lint

# Just type check all packages  
pnpm check-types

# Just build all packages
pnpm build

# Run changed packages with Turborepo
pnpm turbo run build --filter="...[origin/main]"
```

### Debug failed packages
```bash
# Get detailed output for a specific package
pnpm turbo run build --filter=@hipponot/api-core --output-logs=full

# Check what Turborepo thinks changed
pnpm turbo run build --dry=json --filter="...[origin/main]" | jq '.tasks[].package'
```

### Speed up checks with Turborepo
```bash
# Only check packages that changed since main
pnpm ci:check:changed

# Use Turborepo's remote caching (if configured)
pnpm turbo run build --remote-only
```

## Package Development Workflow

### 1. Standard Development Loop
```bash
# Make changes to packages/my-package/
pnpm quick:check @hipponot/my-package  # Fast feedback
# Fix any issues
pnpm ci:check @hipponot/my-package     # Full validation
# Commit changes
```

### 2. Before Creating PR
```bash
pnpm ci:check:changed  # Check all your changes
pnpm ci:check:all      # Optional: full check
```

### 3. Fix Common Issues
```bash
# Add missing test scripts
echo '"test": "vitest run"' # Add to package.json scripts

# Fix imports
pnpm install  # Ensure dependencies are linked

# Build dependencies
pnpm turbo run build --filter=@hipponot/dependency-name
```

## CI/CD Workflow Comparison

| Local Script | GitHub Actions | Purpose |
|-------------|----------------|---------|
| `pnpm ci:check` | `test-and-lint` job | Same exact checks |
| `pnpm quick:check` | Pre-check subset | Fast feedback |
| `pnpm ci:check:all` | Full workflow | All packages |

## Tips

### 🚀 **Speed up development**
- Use `quick:check` for immediate feedback
- Use `ci:check` before committing
- Fix issues locally before pushing

### 🎯 **Focus on changed packages**
- Default `ci:check` only checks changed packages
- Much faster than checking everything
- Same logic as CI/CD

### 🔧 **Debugging**
- Check individual packages with specific commands
- Use `--output-logs=full` for detailed Turborepo output
- Look at `dist/` folders to verify builds worked

### ⚡ **Performance**
- Turborepo caches results - second runs are faster
- Matrix jobs in CI run in parallel (local runs sequentially)
- Use `pnpm` for fast package installation

Now you have the same fast feedback loop locally as CI/CD! 🎉
