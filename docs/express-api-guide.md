# Adding an Express API to `apps/`

This guide explains how to add a new Express-based API application to the `apps/` directory in the saga-soa monorepo.

## 1. Create the App Directory

- Add a new folder under `apps/` (e.g., `apps/my-api`).
- Add a `package.json` with at least:
  - `name`: e.g., `@hipponot/my-api`
  - `type`: `module`
  - `main` and `scripts` fields (see below)

## 2. Set Up the Express App

- Add your entry point (e.g., `src/main.ts`).
- Use `express` for the server:
  ```ts
  import express from 'express';
  const app = express();
  // ...
  app.listen(PORT, () => { ... });
  ```
- Use ESM imports for all dependencies.

## 3. Build Configuration

- Use **tsup** or **bunchee** for building (tsup is common for apps):
  - Add to `devDependencies`: `pnpm add -D tsup --filter ./apps/my-api`
  - Add scripts:
    ```json
    "scripts": {
      "dev": "tsup --watch",
      "build": "tsup",
      "start": "node dist/main.js",
      "test": "jest"
    }
    ```
- Ensure your `tsconfig.json` extends the shared base config and sets `outDir` to `dist`.

## 4. Expressing Dependencies on Packages

- To use a package from `packages/`, add it to `dependencies` in `package.json`:
  ```json
  "dependencies": {
    "@hipponot/api-core": "workspace:*",
    "@hipponot/logger": "workspace:*"
  }
  ```
- Use imports as normal in your code:
  ```ts
  import { RestRouter } from '@hipponot/api-core/rest/rest-router';
  ```

## 5. Unit Testing

- Use **Jest** for unit tests:
  - Add a `jest.config.cjs` (can copy from another app).
  - Place tests in `src/__tests__/` and name them `*.test.ts`.
  - Add `@types/jest`, `jest`, and `ts-jest` to `devDependencies`.
  - Run tests with `pnpm test --filter ./apps/my-api`.

## 6. Example Directory Structure

```
apps/my-api/
  package.json
  tsconfig.json
  jest.config.cjs
  src/
    main.ts
    inversify.config.ts
    sectors/
      hello-rest.ts
    __tests__/
      main.test.ts
```
