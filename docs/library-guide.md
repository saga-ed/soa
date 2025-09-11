# Adding a Library to `packages/`

This guide explains how to add a new reusable library to the `packages/` directory in the saga-soa monorepo.

## 1. Create the Package Directory

- Add a new folder under `packages/` (e.g., `packages/my-lib`).
- Add a `package.json` with at least:
  - `name`: e.g., `@hipponot/my-lib`
  - `type`: `module`
  - `main`, `types`, and `exports` fields (see below)
  - `build`, `dev`, and `test` scripts (see below)

## 2. Set Up Exports

- Use the `exports` field in `package.json` to define what modules/types are public.
- Example:
  ```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
  ```
- Only export files that exist in `dist/` after build.

## 3. Build Configuration

- Use **bunchee** for building:
  - Add to `devDependencies`: `pnpm add -D bunchee --filter ./packages/my-lib`
  - Add scripts:
    ```json
    "scripts": {
      "dev": "bunchee --watch",
      "build": "bunchee",
      "test": "jest"
    }
    ```
- Ensure your `tsconfig.json` extends the shared base config and sets `outDir` to `dist`.

## 4. Expressing Dependencies

- To depend on another package in the monorepo, add it to `dependencies` in `package.json`:
  ```json
  "dependencies": {
    "@hipponot/config": "workspace:*"
  }
  ```
- Use `import` statements as normal in your TypeScript code.

## 5. Unit Testing

- Use **Jest** for unit tests:
  - Add a `jest.config.cjs` (can copy from another package).
  - Place tests in `src/__tests__/` and name them `*.test.ts`.
  - Add `@types/jest`, `jest`, and `ts-jest` to `devDependencies`.
  - Run tests with `pnpm test --filter ./packages/my-lib`.

## 6. Example Directory Structure

```
packages/my-lib/
  package.json
  tsconfig.json
  jest.config.cjs
  src/
    index.ts
    __tests__/
      index.test.ts
```
