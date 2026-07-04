# Verify — health, data, and source posture

← [Getting started](./getting-started.md)

`ss stack status` is a **read-only** health probe (never exits non-zero). `ss stack verify`
is the **gating** check — it exits non-zero when something that should be up isn't. All native.

## Health only (the default gate)

```bash
ss stack verify --only scheduling-api,sessions-api
```

<details><summary>✓ each service's manifest-derived health endpoint returns 200 — else exit 1</summary>

```
── service health ──
✓ iam-api          http://localhost:3010/health  (200)
✓ programs-api     http://localhost:3006/health  (200)
✓ scheduling-api   http://localhost:3008/health  (200)
✓ sessions-api     http://localhost:3007/health  (200)
✓ verify: health green
```

Scope with `--only`/`--with` so a partial `up` verifies just what it launched. `--tolerate a,b`
allows named services to be down. Because health is manifest-derived, `verify` covers
endpoints the hand-maintained `verify.sh` list missed.
</details>

## `--full` — health + data + source posture

```bash
ss stack verify --full
```

<details><summary>✓ health gate + data checks (D1–D5) + source-posture — posture is warn-only</summary>

```
── service health ──
✓ iam-api … (200)   ✓ programs-api … (200)   ✓ scheduling-api … (200)   …
── data ──
✓ iam_local seeded (users present)
✓ sis_db migrated · connect-mongo reachable
✓ deterministic ids present · admin personas seeded
── source posture ──
· soa on gh_214 (not main) — leaving overlay/feature branch as-is
⚠ rostering behind origin/main by 3 — pull to refresh
✓ verify --full: health + data green (2 posture warning(s))
```
</details>

## What FAILS vs what WARNS

This is the important contract:

| Check | Class | Effect on exit code |
|---|---|---|
| A required service is **down** | health | **fails** (exit 1) |
| iam not seeded / sis_db unmigrated / mongo unreachable | data | **fails** (exit 1) |
| On a feature branch, behind origin, unmerged pin, unpinned overlay | **source posture** | **warn only** — never fails |
| `users == 205` | note | never fails (journey/partial profiles vary) |

Source-posture (P1–P4) is *drift detection* — it prints warnings so you notice a stale
checkout, but it **cannot** flip verify's verdict (that's guaranteed by construction — the
posture result type has no "fail" variant). gh/git/network hiccups during posture degrade to
a "couldn't check" note, never a crash.

← [Getting started](./getting-started.md) · [snapshots →](./snapshots.md)
