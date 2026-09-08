# Turborepo & pnpm Workspace Specification

## Overview

This project uses [Turborepo](https://turbo.build/) in combination with [pnpm workspaces](https://pnpm.io/workspaces) to manage a monorepo of TypeScript packages and applications. The workspace is organized under the `packages/` and `apps/` directories, with each submodule (e.g., `@saga-ed/config`, `@saga-ed/db`) as a separate package.

## Internal Dependency Management

- **Internal packages are made accessible to each other using pnpm workspace dependencies, not TypeScript project references.**
- To depend on another internal package, add it to your `package.json` as:
  ```json
  "dependencies": {
    "@saga-ed/config": "*"
  }
  ```
  or
  ```json
  "dependencies": {
    "@saga-ed/config": "workspace"
  }
  ```
- This ensures that pnpm links the local package for development and builds, and resolves imports like `import { X } from '@saga-ed/config'` correctly.
- **Do not use TypeScript project references** (i.e., no `"references"` field in `tsconfig.json`).
- TypeScript `paths` mappings are not required for internal workspace imports, as pnpm handles resolution.

## Rationale

- **Simplicity:** Using pnpm workspace dependencies avoids the complexity and build order issues of TypeScript project references.
- **Consistency:** All internal packages are versioned and linked by pnpm, making dependency management explicit and consistent.
- **Compatibility:** This approach works seamlessly with Turborepo's task pipeline and caching, and is compatible with standard TypeScript and Node.js tooling.

## Best Practices

- Always use the `@saga-ed/` scope for internal packages.
- Keep internal dependencies up to date by running `pnpm install` at the root after modifying any `package.json`.
- Use the `exports` field in each package's `package.json` to control what is accessible to consumers (internal and external).
- Avoid circular dependencies between packages.
- Document any special import conventions or subpath exports in the memory bank.

## Example

If `@saga-ed/db` depends on `@saga-ed/config`, add to `packages/db/package.json`:

```json
"dependencies": {
  "@saga-ed/config": "*"
}
```

Then, in your code:

```ts
import { IConfigManager, MockConfigManager } from '@saga-ed/config';
```

## See Also

- [pnpm workspaces documentation](https://pnpm.io/workspaces)
- [Turborepo documentation](https://turbo.build/docs)
