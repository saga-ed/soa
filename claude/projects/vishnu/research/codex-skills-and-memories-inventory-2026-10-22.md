# Inventory: Claude skills, instructions & memories to point Codex at

_Captured 2026-10-22 from skelly's machine. Purpose: tell Codex (OpenAI) which
directories hold the skills, instructions, and memories Claude uses day-to-day
to build saga-ed components._

## Key caveats

- **Format gap.** Codex reads `AGENTS.md` (hierarchical; global at
  `~/.codex/AGENTS.md`), not `CLAUDE.md`, and does not follow Claude's
  `@path` imports. Recent Codex builds also load `SKILL.md` folders from
  `~/.codex/skills/` (same format as Claude skills) — verify against the
  installed Codex version.
- **Broken existing translation.** `/home/skelly/dev/AGENTS.md` already exists
  but was produced by a blind `Claude`→`Codex` substitution, so real paths like
  `<repo>/.claude/worktrees/` became nonexistent `<repo>/.Codex/worktrees/`.
  Fix before relying on it.

## 1. Always-on instructions (highest value)

| What | Path |
|---|---|
| Personal conventions (naming, project dirs, `PR#`/`I#`) | `/home/skelly/dev/skilgoreT-skills/facts/preferences.md` |
| Cross-repo protocol (absolute paths, worktrees, status) | `/home/skelly/dev/CLAUDE.md` |
| Worktree rules | `/home/skelly/dev/WORKTREES.md` |
| Saga org-wide context + shared memories | `/home/skelly/dev/saga-ai-context/` (`CLAUDE-org.md`, `memories/`, `SHARED-MEMORIES-REGISTRY.md`) |

`/home/skelly/.claude/CLAUDE.md` only imports `preferences.md` — skip it.

## 2. Per-repo instructions

Each has a `CLAUDE.md`; `+rules` means a `.claude/rules/` dir too (Codex
won't load either automatically).

- `/home/skelly/dev/soa/` (repo skills: `claude-audit`, `qa-cross-validation`)
- `/home/skelly/dev/student-data-system/` (+rules)
- `/home/skelly/dev/saga-dash/` (+rules)
- `/home/skelly/dev/coach/` (+rules, skill `claude-audit`)
- `/home/skelly/dev/iac/` (+rules)
- `/home/skelly/dev/rostering/` (+rules)
- `/home/skelly/dev/qboard/` (+rules)
- `/home/skelly/dev/fleek/` (+rules)
- `/home/skelly/dev/thrive/` (skill `claude-audit`)
- `/home/skelly/dev/offline-analytics/` (skill `saga-analytics`)
- Also: `/home/skelly/dev/program-hub/`, `/home/skelly/dev/microservices/`,
  `/home/skelly/dev/rtsm/`, `/home/skelly/dev/saga-sm/`, `/home/skelly/dev/deidentify/`

## 3. Personal skills

Source: `/home/skelly/dev/skilgoreT-skills/skills/`
(github.com/skilgoreT/skilgoreT-skills), symlinked into
`/home/skelly/.claude/skills/`.

- Daily: `project`, `wootdev-db`, `open-doc`, `capture-evidence`
- Situational: `prod-db` (prod-write route is skilgoreT-only), `assume-identity`
  (prod impersonation needs explicit confirmation each time),
  `capture-response`, `deploy`

Several depend on the Claude-in-Chrome extension (`open-doc`, `capture-*`,
`assume-identity`); those parts won't run under Codex.

## 4. Saga team plugins (marketplace `saga-ed/claude-plugins`)

Source checkout: `/home/skelly/dev/claude-plugins/plugins/` — each plugin has
`skills/*/SKILL.md`, most with reference docs alongside.

- **Daily:**
  - `saga-iac`: ss, scaffold, add-service, review, saga-explain,
    auth-design, authz-design, database-guidance, outbox-projection,
    patch-party, discover-aws-access, iam-diff, harvest
  - `spec-driven-dev`: spec-workshop, test-workshop, spec-review,
    spec-debug, spec-status, spec-triage, spec-context
  - `documentation-system`
- **Regular:** `system-review`, `compliance-audit`, `qa-review`,
  `standup-deck`, `staff-admin`
- **In the marketplace but not installed for skelly:** `saga-fleet`
  (fleet-map), `saga-dev-sec`, `saga-incident`, `project-kit`,
  `test-assistant`

The installed cache (`/home/skelly/.claude/plugins/cache/saga-tools/`) holds
several versions of some plugins — point Codex at the source checkout instead.

## 5. Memories (notes the agent wrote down)

One memory dir per working directory, each indexed by `MEMORY.md`:

- `/home/skelly/.claude/projects/-home-skelly-dev/memory/` — cross-repo
  notes (CodeArtifact 401 → `co-login.sh`, staff-admin MCP failures usually
  mean off-VPN, prod Postgres SQL visibility, decide things one at a time).
- `/home/skelly/.claude/projects/-home-skelly-dev-student-data-system/memory/`
  — largest set (~20): synthetic-dev gotchas, commit/deploy habits, never
  auto-merge saga-dash.
- `/home/skelly/.claude/projects/-home-skelly-dev-soa/memory/` — ss slot
  assignments.
- Smaller sets: `-home-skelly-dev-saga-dash`, `-home-skelly-dev-thrive`,
  `-home-skelly-dev-nimbee`, `-home-skelly-dev-claude`, all under
  `/home/skelly/.claude/projects/`.

## Suggested Codex wiring

1. Fix `/home/skelly/dev/AGENTS.md`, or regenerate it from `CLAUDE.md`
   without rewriting paths.
2. Inline the contents of `preferences.md` into `~/.codex/AGENTS.md`
   (Codex won't follow a link).
3. Add per-repo `AGENTS.md` files telling Codex to read that repo's
   `CLAUDE.md` and `.claude/rules/`.
4. Symlink the skill dirs from sections 3 and 4 into `~/.codex/skills/`.
5. Reference the memory dirs from `AGENTS.md` as background reading.
