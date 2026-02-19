# SOA Core Applications

Runtime-agnostic applications (CLI tools, scripts).

## Parent Context

See [/apps/CLAUDE.md](../CLAUDE.md) for apps overview.

## Runtime Environment

**Type**: Runtime-agnostic
**Target**: Node.js 20+ (ESM) or Browser

## Purpose

This tier is reserved for applications that:
- Work in any JavaScript runtime
- Don't depend on runtime-specific APIs
- Include CLI tools, code generators, scripts

## Projects

Currently empty. Web/browser apps go in `web/`, Node.js apps go in `node/`.

## Guidelines

If creating a new app here, ensure it:
- Uses only runtime-agnostic dependencies
- Works with both Node.js and browser (if applicable)
- Documents any runtime constraints

---

*Last updated: 2026-02*
