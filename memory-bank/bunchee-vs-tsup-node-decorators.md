# Bunchee vs. Tsup for Node.js Libraries with Decorators

## Why Bunchee Was Used

Bunchee is a zero-config bundler designed for building modern JavaScript/TypeScript libraries, especially for ESM and browser compatibility. It is often chosen for:

- **Simple ESM-first builds:** Defaults to ESM output, ideal for npm libraries used in both Node.js and browsers.
- **Automatic bundling:** Bundles dependencies and assets for a single distributable file.
- **TypeScript support:** Handles TypeScript out of the box (with some limitations).
- **No config needed:** Great for simple libraries—just run `bunchee` and get a working ESM build.

In this project, bunchee was likely chosen to:

- Provide a modern, ESM-first, zero-config build for packages like the logger.
- Make it easy to publish libraries for both browser and Node.js consumers.

## Why We Switched Away from Bunchee for Logger

- Bunchee (and its underlying SWC) does **not** fully support transpiling TypeScript experimental decorators for Node.js.
- This is required for frameworks like Inversify (dependency injection), which rely on decorators.
- Bunchee's output left decorators in the JS, causing runtime errors in Node.js.
- `tsup` (or `tsc`) is more reliable for Node.js libraries that use decorators, as it correctly transpiles them away.

## Rule/Reminder for Developers

> **When adding a new TypeScript library to this monorepo:**
>
> - **Prefer `bunchee`** for simple, ESM-first libraries that do **not** use experimental decorators.
> - **If your library uses experimental decorators** (e.g., for Inversify or other DI frameworks targeting Node.js), **use `tsup` or `tsc` instead** to ensure correct transpilation and Node.js compatibility.

---

_Last updated: 2024-06-29_
