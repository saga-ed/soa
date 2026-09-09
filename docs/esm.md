> Reference. Verified against code 2026-09-08 — the "Real Example" below
> is `mesh-fixture-cli`'s live fixture-path resolution (source, not a
> test); every other claim (repo-wide `"type": "module"`, the
> `fileURLToPath(import.meta.url)` pattern, `.js` import extensions) still
> holds.

# ECMAScript Modules (ESM) Patterns

Runtime-agnostic patterns for ES modules. Applies to Node.js, Deno, Bun, and other ESM runtimes.

## Philosophy

All SOA packages and applications use **ECMAScript Modules (ESM)** exclusively:
- `"type": "module"` in all package.json files
- `.js` extensions required in imports
- No CommonJS (`require()`, `module.exports`)

## __dirname and __filename in ESM

**Problem**: CommonJS globals `__dirname` and `__filename` are not available in ESM.

**Solution**: Use `import.meta.url` with runtime path utilities:

```typescript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Now use as normal
const schemaPath = path.resolve(__dirname, '../../schemas/**/*.gql');
```

### When to Use

- Resolving file paths relative to the current module
- Loading config files, schemas, or fixtures
- Path resolution in test setup (e.g., schema patterns, test data)
- Any time you need absolute paths from module location

### Why This Matters

**Working Directory Independence**: Tests and scripts run from different CWDs (package root vs monorepo root vs arbitrary directory).

```typescript
// ❌ BAD: Breaks when run from different directories
const schemaPath = 'schemas/**/*.gql';
const schemaPath = './schemas/**/*.gql';

// ✅ GOOD: Works regardless of CWD
const schemaPath = path.resolve(__dirname, '../../schemas/**/*.gql');
```

### Real Example

```typescript
// packages/node/mesh-fixture-cli/src/lib/load-fixture-definition.ts
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_SOURCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
);
```

**Result**: `FIXTURES_SOURCE_DIR` resolves relative to the module's own
location, not the process's working directory — correct whether the
compiled `dist/` output runs inside the soa workspace or is consumed via
workspace-link from another repo.

### Alternative Approach

For simple path resolution without Node.js path utilities:

```typescript
// Works in Node.js, Deno, and Bun
const schemaDir = new URL('../../schemas/', import.meta.url).pathname;
```

**Choose**:
- `fileURLToPath` + `path.resolve` - When using Node.js path APIs
- `new URL()` - For simple URL-based path construction

## Import Specifiers

Always include `.js` extensions (even for `.ts` source files):

```typescript
// ✅ GOOD
import { Foo } from './foo.js';
import { Bar } from '../bar.js';

// ❌ BAD
import { Foo } from './foo';
import { Bar } from '../bar';
```

**Why**: ESM spec requires explicit extensions. TypeScript transpiles `.ts` → `.js`, so import paths must target the output.

## Dynamic Imports

Dynamic imports work in ESM but have caveats:

```typescript
// Works at runtime
const module = await import('./module.js');

// ⚠️ Issues in test environments with decorators/DI
// See .claude/rules/testing-node.md for test-specific guidance
```

## Top-Level Await

ESM enables top-level await (no async wrapper needed):

```typescript
// ✅ Valid in ESM
const config = await loadConfig();
const db = await connectDatabase();

export { config, db };
```

**Use Cases**:
- Loading async configuration
- Establishing connections before module exports
- Dynamic feature detection

**Avoid**:
- Side effects in imported modules (prefer explicit initialization)
- Long-running operations (blocks import graph)

## CommonJS Interop

Importing CommonJS modules into ESM:

```typescript
// CommonJS module (legacy package)
// const foo = require('legacy-package');

// ESM import (default export from CJS)
import legacyPackage from 'legacy-package';

// Named imports often don't work with CJS
// Use namespace import instead:
import * as legacy from 'legacy-package';
```

**Note**: Most modern packages provide ESM exports. Check `package.json` `exports` field.

## Module Resolution

Use Node.js resolution with `node:` prefix for built-ins:

```typescript
// ✅ GOOD: Explicit Node.js built-in
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ Works but less explicit
import fs from 'fs';
import path from 'path';
```

**Why**: Makes built-ins visually distinct from user code and external packages.

## See Also

- [.claude/rules/testing-node.md](../.claude/rules/testing-node.md) - ESM patterns in tests
- [tooling/pnpm.md](./tooling/pnpm.md) - Workspace package resolution
