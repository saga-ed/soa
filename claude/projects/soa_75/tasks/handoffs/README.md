# soa_75 — handoff briefings for concurrent Claude sessions

These are self-contained briefing docs intended to be the **kickoff
prompt** for a fresh Claude Code session opened in the named repo. Each
one points back at `../lateral-propagation.md` as the source of truth
for which items are owned by which session.

## Active sessions

| File | Repo | Base branch | Owns | Status |
|---|---|---|---|---|
| [`session-a1-soa-package-bump.md`](session-a1-soa-package-bump.md) | `saga-ed/soa` | **`main`** ⚠️ | 1.1, 1.2, 1.3 (docstring), 1.5 (README), 1.6, 1.8, 2.3 | running |
| [`session-b-rostering-contract-check.md`](session-b-rostering-contract-check.md) | `saga-ed/rostering` | `feat/iam-events-adoption` | 2.1 (rostering), 2.4 (rostering) | running |
| [`session-c-program-hub-contract-check.md`](session-c-program-hub-contract-check.md) | `saga-ed/program-hub` | `saga-ed/event-driven-adoption` | 2.1 (program-hub), 2.4 (program-hub), 4.1 | running |

Sessions A1, B, and C run **concurrently**. Coordination boundary:
**only A1 may bump `@saga-ed/soa-event-*` dev tags**; B and C consume
whatever versions the existing adopter PRs already pin.

> **Branch correction (2026-05-06):** an earlier draft of these
> handoffs put A1 on `soa_75` and pointed B/C at `?ref=soa_75` for
> package source. That was wrong — the `@saga-ed/soa-*` event-driven
> packages live on `main`. soa_75 is the planning/decisions branch and
> carries no package source. The handoffs have been corrected; if a
> running session was started against the original drafts, re-read
> the corrected briefings and re-base off `main` (or the appropriate
> adopter base branch).

## Scheduled but not yet kicked off

- **Session A2** — soa decision-doc updates on `soa_75` (1.4 options
  doc, 1.5 decision-side rule, 1.7 projection deletion guidance, 1.3
  rationale doc, 4.2 cross-links). Handled inline in Seth's primary
  session. **Note:** the README/docstring portions of 1.2, 1.3, 1.5
  are now folded into Session A1's scope (since A1 is on `main` and
  touching those packages). A2 just owns the decision-doc updates on
  `soa_75`.
- **Session D** — adopter cleanup pass after A1 merges (delete in-tree
  `id()` copies, swap to `upsertProjection`, set `failureMode`
  explicitly). Will be drafted once A1 names its dev-tag set.

## Deferred (won't kick off now)

- **sds onboarding** (items 3.1, 5.1–5.3) — wait until sds joins.
- **3.2** db-host `max_connections` — wait until concurrent-PR count grows.
- **3.3** DLQ alert template, **1.9** trace-ID in logs, **2.5** rabbitmq
  template — P3, no urgency.

## Ground rules for all sessions

1. **Source of truth is `../lateral-propagation.md`** on `soa_75`. Tick
   items there when work merges (you'll need a soa-repo worktree to do that).
2. **Stay in scope.** Each handoff has explicit "out of scope" items.
   Don't drift; if you spot something genuinely urgent, raise it back to
   Seth instead of expanding scope mid-session.
3. **Don't bump shared `@saga-ed/soa-event-*` dev tags** unless you're
   Session A1.
4. **Per global CLAUDE.md:** no AI signature in commits/PRs, English
   commit messages, worktrees under `.claude/worktrees/`, no
   `--no-verify`, no force-push to main.
5. **Per project CLAUDE.md (soa):** always ask before file write/delete
   commands except pnpm/turbo. Use 4-space indentation. Tests for new
   features. pnpm only.

## How a session kicks off

In a fresh Claude Code instance with the relevant repo as cwd:

```
Read claude/projects/soa_75/tasks/handoffs/<your-session>.md from the
saga-ed/soa repo on the soa_75 branch. Treat it as your full briefing.
Confirm scope before starting work.
```

Or paste the file contents directly into the prompt. The doc is written
to be self-contained.
