# TypeScript Type Resolution Checklist for Local Packages

This checklist documents the step-by-step process to ensure TypeScript correctly resolves types for local packages in the saga-soa monorepo. Use this whenever introducing a new import from a local package (e.g., `@hipponot/logger`) in any application under `apps/`.

---

## Step-by-Step Type Resolution Check

1. **Build Output in Package**

   - Ensure the package (e.g., `packages/logger`) has a `dist/` directory with both `index.js` and `index.d.ts` (or equivalent entry files).
   - Confirm all relevant types (e.g., interfaces, types) are exported from the built `.d.ts` file.

2. **Exports and Types in `package.json`**

   - Check that the package's `package.json` includes:
     - `"main": "dist/index.js"`
     - `"types": "dist/index.d.ts"`
     - An `exports` field mapping `.` to both the type and JS entry points.

3. **Workspace Inclusion**

   - Verify the package is included in `pnpm-workspace.yaml` (e.g., under `packages/*`).

4. **Dependency in App**

   - Add the package as a dependency in the target app's `package.json` using the workspace protocol:
     ```sh
     pnpm add <package-name>@workspace:* --filter <app-path>
     ```
   - Example: `pnpm add @hipponot/logger@workspace:* --filter ./apps/examples/rest_api`

5. **Symlink and Node Modules**

   - Confirm that the app's `node_modules` contains a symlink to the local package, and that the `dist/` directory is present and correct under the symlink.

6. **Build and Type Check**

   - Run the app's build and type-check scripts (e.g., `pnpm run build`, `pnpm run check-types`).
   - Ensure there are no type resolution errors for the imported package.

7. **Editor/TS Server**
   - If errors persist in your editor, restart the editor or TypeScript server to clear stale state.

---

## Rule: Type Resolution Checklist for New Package Imports

**Whenever you introduce a new import from a local package (from `packages/`) in any application under `apps/`, you MUST execute the above checklist to ensure type resolution works as expected.**

- Document the outcome in the memory bank if any issues or workarounds are required.
- If the checklist fails at any step, resolve the issue before proceeding with further development.

---

_Last updated: 2024-06-29_
