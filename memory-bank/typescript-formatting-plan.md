# TypeScript Formatting Standardization Plan

## Overview

Standardize TypeScript source file formatting across all example projects to ensure consistency and improve developer experience.

## Current Issues Identified

### 1. Import Formatting Inconsistencies

- **trpc-api**: Uses aligned imports with spaces (e.g., `import { ExpressServer }            from '@hipponot/api-core/express-server';`)
- **rest-api**: Uses compact imports (e.g., `import { ExpressServer } from '@hipponot/api-core/express-server';`)
- **graphql-api**: Uses compact imports but with inconsistent spacing
- Mixed spacing patterns across all examples

### 2. No Consistent Formatting Configuration

- No Prettier config files in the examples
- No ESLint config files in the examples
- Existing ESLint config in `packages/eslint-config/base.js` but not utilized
- No formatting scripts in package.json files

### 3. Inconsistent Spacing and Indentation

- Mixed use of single and double quotes
- Inconsistent spacing around operators and brackets
- Different line break patterns
- Inconsistent comment formatting

## Solution Plan

### Phase 1: Configuration Setup

1. **Create root `.prettierrc.json`** with consistent formatting rules
2. **Create root `eslint.config.js`** that extends existing base config
3. **Add format scripts** to each example's package.json

### Phase 2: Formatting Implementation

1. **Run Prettier** on all TypeScript files in examples
2. **Run ESLint** to fix any remaining issues
3. **Verify consistency** across all files

### Phase 3: Documentation

1. **Update README** with formatting guidelines
2. **Add pre-commit hooks** (optional)
3. **Document formatting workflow** for developers

## Detailed Implementation Steps

### Step 1: Create Root Prettier Configuration

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "bracketSpacing": true,
  "arrowParens": "avoid"
}
```

### Step 2: Create Root ESLint Configuration

- Extend existing `packages/eslint-config/base.js`
- Add TypeScript-specific rules
- Configure for ESM modules

### Step 3: Add Package.json Scripts

Add to each example's package.json:

```json
{
  "scripts": {
    "format": "prettier --write \"src/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\"",
    "lint": "eslint \"src/**/*.ts\" --fix"
  }
}
```

### Step 4: Run Formatting

- Format all TypeScript files in `apps/examples/*/src/**/*.ts`
- Ensure consistent import formatting
- Standardize spacing and indentation

## Benefits

- **Consistent code style** across all examples
- **Automated formatting** with npm scripts
- **Better developer experience** with standardized formatting
- **Easier maintenance** with consistent patterns
- **Reduced code review friction** with standardized formatting

## Files to Format

- `apps/examples/rest-api/src/**/*.ts` (15 files)
- `apps/examples/trpc-api/src/**/*.ts` (20 files)
- `apps/examples/graphql-api/src/**/*.ts` (10 files)
- Configuration files: `vitest.config.ts`, `tsup.config.ts`, etc.

## Success Criteria

- All TypeScript files follow consistent formatting
- Import statements are consistently formatted
- Spacing and indentation are uniform
- No ESLint errors or warnings
- Formatting can be automated with npm scripts

## Notes

- Preserve existing functionality while improving formatting
- Ensure ESM compatibility with formatting rules
- Consider adding pre-commit hooks for automated formatting
- Document formatting standards for team consistency
