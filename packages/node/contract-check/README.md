# @saga-ed/soa-contract-check

CI gate for event-schema changes across services. Catches three classes of mistake:

1. Modifying a frozen-forever schema in place (D5/D6 violation).
2. Adding a new schema version without recording it in pins.
3. Dropping a published version while a consumer still pins it.

The same shape works in single-repo and multi-repo settings. The publisher repo's `pins/` directory is the source of truth; in a multi-repo fleet, downstream consumers in other repos open PRs against the publisher repo's pins.

See the canonical decision docs in the `soa_75` branch:
- `claude/projects/soa_75/decisions/d-contract-testing.md`
- `claude/projects/soa_75/decisions/d-event-versioning.md`

## Install

```bash
pnpm add -D @saga-ed/soa-contract-check
```

## Configure

Place `contract-check.config.ts` (or `.js`/`.mts`/`.mjs`) at your repo root:

```ts
// contract-check.config.ts
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@saga-ed/soa-contract-check';
import { iamEvents } from '@saga-ed/iam-events';
// import { programsEvents } from '@saga-ed/programs-events'; // when added

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    registry: {
        ...iamEvents,
        // ...programsEvents,
    },
    publishedDir: resolve(repoRoot, 'tools/contract-check/published'),
    pinsGlob: resolve(repoRoot, 'apps/*/pins/*.yaml'),
});
```

`defineConfig` is an identity helper — it exists purely so you get TypeScript checks on the config object without remembering a `: ContractCheckConfig` annotation. If your repo has no `apps/<svc>/pins/` layout (e.g., a library repo), set `pinsGlob: null` to skip the pins layers.

**Registry-key convention.** Each entry's key MUST be `${eventType}.v${eventVersion}` (per-family event packages typically build this for you). The tool asserts the key↔descriptor match at the start of every run and throws loudly on drift — the snapshot path is derived from the key while the pins-coverage layer is derived from the descriptor's fields, so a typo'd key would diverge silently otherwise.

## Use

Add scripts to `package.json`:

```jsonc
{
    "scripts": {
        "contract:check": "soa-contract-check check",
        "contract:export": "soa-contract-check export",
        "contract:export:write": "soa-contract-check export --write"
    }
}
```

Then:

```bash
pnpm contract:check          # CI gate; non-zero on any violation
pnpm contract:export         # diff-only — show what would change
pnpm contract:export:write   # write NEW snapshots; refuses to overwrite existing versions
```

**Modifying a published version (D5/D6 violation).** `export --write` deliberately refuses to overwrite an existing snapshot whose bytes have changed and exits non-zero. To override — e.g. you genuinely intend to bump and need to regenerate — re-run with `--bump`:

```bash
soa-contract-check export --write --bump
```

Without `--bump`, a developer who edits a frozen schema and runs `export --write` would silently launder the change through committed bytes; the next `check` would pass against the new schema, defeating the gate. `--bump` is the explicit gesture that says "I know I'm modifying an existing version."

Wire `pnpm contract:check` into your CI workflow as the merge gate.

## The three layers

### 1. Snapshot byte-diff (publisher side)

For each event in `config.registry`, the tool renders the Zod payload schema to JSON Schema and compares it byte-for-byte against the committed snapshot in `<publishedDir>/<eventType>-vN.json`.

- **Adding a new version**: render fails to find a snapshot → run `soa-contract-check export --write` to write it, then commit.
- **Editing a published version**: any byte-level difference fails the check. Per the frozen-forever rule, modifying a published schema is a wire-break disguised as a typo fix. Bump to a new version instead.

The snapshots are the source of truth for "what was promised over the wire."

### 2. Pins coverage

Each event type has a single pins file owned by the publishing service:

```
apps/<publisher-svc>/pins/<eventType>.yaml
```

Example (`apps/iam-api/pins/iam.user.created.yaml`):

```yaml
eventType: iam.user.created
publisher:
    service: iam-api
    package: '@saga-ed/iam-events'
versions_published: [1, 2]
consumers:
    - service: programs-api
      versions: [1, 2]
      # repo: saga-ed/program-hub  # for cross-repo consumers
```

The coverage check requires `versions_published` to **equal** the set of versions in the registry:

- Adding `v3` to the registry without updating `versions_published: [1, 2, 3]` → fails.
- Listing a version in `versions_published` that the registry doesn't have → fails.
- Adding a new event type without creating a pins file → fails.
- Creating a pins file for an event type the registry doesn't know about → fails.

### 3. Pins consumer validity (drop-protection)

Each consumer's `versions[]` must be a subset of `versions_published`. This is the layer that protects against premature version drops.

If `iam-api` opens a PR shrinking `versions_published: [1, 2]` to `[2]`, the check fails until each consuming service opens a PR (against the publisher repo's pins file) dropping its v1 pin.

## Cross-repo coordination

In a multi-repo fleet, pins live with the publisher. Downstream consumers in other repos open PRs against the publisher's `apps/<svc>/pins/` directory:

- Consumer adopts v2: PR against publisher repo bumping their entry to `versions: [1, 2]`.
- Publisher drops v1: PR shrinking `versions_published: [1, 2]` → `[2]`. CI fails because consumers still pin v1. Coordinate: each consuming team opens a PR (against the publisher repo) dropping their v1 pin. Once all are merged, the publisher PR re-runs and passes.

The `repo:` field on each consumer entry tells the publisher's CI which downstream team to ping when a coverage failure happens.

No central registry, no fleet-wide configuration service. The pins file in the publisher's repo is the single source of truth for "who consumes what version of this event."

## Common failure modes

| Failure | What happened | Fix |
|---|---|---|
| `[snapshot] Snapshot iam.user.created-v1.json differs` | Edited a frozen schema | Revert and bump to a new version |
| `[snapshot] Missing snapshot iam.user.created-v3.json` | Added v3 to registry, no snapshot | `soa-contract-check export --write` and commit |
| `[pins-coverage] versions_published doesn't match the registry` | Schema set and pins drifted | Update `versions_published` to match the registry |
| `[pins-coverage] Registry has X but no pins file exists` | Forgot to create pins file | Create `apps/<publisher>/pins/<eventType>.yaml` |
| `[pins-validity] programs-api pins iam.user.created v[1] but versions_published is [2]` | Publisher tried to drop a version a consumer still uses | Coordinate: consumer drops pin first |

## Programmatic API

```ts
import { runCheck, runExport, loadConfig } from '@saga-ed/soa-contract-check';

const { config } = await loadConfig();
const result = await runCheck(config);
if (result.failures.length > 0) { /* … */ }
```

## Provenance

Lifted from `soa_event_driven_example/tools/contract-check/` (the POC), parameterized by config so it works against any repo layout. The PoC's hardcoded event imports are replaced with the user-supplied `config.registry`.
