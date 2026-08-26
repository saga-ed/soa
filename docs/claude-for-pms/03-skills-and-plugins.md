# 03 — Skills & Plugins

This is where most of the day-to-day value lives. A **skill** is a packaged
procedure — Saga's own conventions, a review checklist, a deploy runbook —
that Claude follows instead of improvising. A **plugin** is a bundle of skills
(and sometimes MCP servers and subagents) you install as a unit.

The practical effect: instead of explaining how Saga does something every time,
you type `/spec-status` and Claude already knows.

---

## How to install things

Plugins come from **marketplaces**. You add a marketplace once, then install from
it.

```
/plugin marketplace add saga-ed/claude-plugins
/plugin install system-review@saga-tools
```

Then `/reload-plugins` if prompted.

> **Do this from the Claude Code terminal, not the VS Code integration.** The
> editor integration hides parts of the interactive UI and the install will look
> like it silently did nothing. This has caught people out.

Useful: `/plugin` on its own opens the manager — browse, update, remove.

`saga-soa` registers the `saga-tools` marketplace in its `.claude/settings.json`,
so **in this repo the Saga skills are already there**. You'll need to add it
yourself in repos that don't.

---

## What's available

Three marketplaces are in play.

### `saga-tools` — Saga's own

[github.com/saga-ed/claude-plugins](https://github.com/saga-ed/claude-plugins#readme)

| Plugin | What it does |
|---|---|
| **system-review** | Systematic codebase review — full, investigation, and targeted modes |
| **documentation-system** | Maintains the hierarchical `CLAUDE.md` docs — audit, search, tidy |
| **compliance-audit** | Compliance auditing against pluggable specs, with 5-point scoring |

### `claude-plugins-official` — Anthropic's catalog

Large, and full of third-party integrations. The ones PMs actually reach for:

| Plugin | Why you'd want it |
|---|---|
| **github** | Issues, PRs, boards — bundles the GitHub MCP server |
| **slack** | Channel digests, finding decisions, drafting announcements |
| **datadog** | Is production okay? See [04](04-mcp-servers.md#datadog) |
| **figma** | Read comps as structured data |
| **linear**, **asana**, **atlassian**, **notion** | If you use these for planning |
| **amplitude**, **posthog** | Product analytics |
| **sentry** | Error tracking |
| **miro**, **canva** | Whiteboards and design assets |
| **intercom** | Customer conversations |

Install any of them the same way: `/plugin install <name>@claude-plugins-official`.

### `claude-code-plugins` — community and Anthropic extras

Includes `code-review`, `feature-dev`, `frontend-design`, `commit-commands`,
`plugin-dev`. More engineering-oriented, but `code-review` is worth having if you
review PRs.

---

## The skills a Saga PM will actually use

Grouped by the job you're doing. All of these are available in the current Saga
setup.

### Specs and requirements

The `spec-driven-dev` skills are explicitly **PM-aware** — they adapt their output
for a PM audience rather than assuming you want implementation detail.

| Skill | Use it when |
|---|---|
| `/spec-workshop` | Writing or updating a behavioural spec; sketching cases for a feature still being defined. Works from PM language. |
| `/spec-status` | You need a stakeholder-readable digest, or a **manual test plan** generated from a spec |
| `/spec-triage` | Sprint boundaries — which drafts are stale, which are ready to promote |
| `/spec-review` | Checking spec/test alignment and coverage gaps |
| `/spec-context` | Capturing a decision or glossary term so it survives between sessions |
| `/spec-debug` | "Is this a bug, or did I misunderstand the intended behaviour?" |

### QA and verification

| Skill | Use it when |
|---|---|
| `/assume-identity` | See the app as a specific user. **Prod is gated** — needs skelly's sign-off every time. |
| `/capture-evidence` | Record a GIF proving a fix works, file it, attach it to the issue |
| `/ss` | Drive the synthetic dev stack — up, down, seed, reset, verify |
| `/run` | Launch the app to see a change working |

### Communication and reporting

| Skill | Use it when |
|---|---|
| `/standup-deck` | Build today's standup deck from what actually moved |
| `/slack:channel-digest` | Catch up across several channels at once |
| `/slack:find-discussions` | "Where did we decide X?" |
| `/slack:summarize-channel` | One channel, recent activity |
| `/slack:draft-announcement` | Draft a well-formatted announcement (saves as a draft — nothing sends) |
| `/slack:standup` | Standup update from your own recent activity |

### Finding things

| Skill | Use it when |
|---|---|
| `/find-in-docs` | "Where is X documented? Who owns it?" — searches the docs hierarchy structurally |
| `/saga-explain` | "Why does Saga do it this way?" — read-only reference lookup on infra and conventions |
| `/capture-response` | Pin an answer you'll want again; retrieve pins from any session |
| `/open-doc` | Render a markdown file as a readable page in Chrome |

### Working on an issue

| Skill | Use it when |
|---|---|
| `/project` | Set up, manage, or close out a per-issue working directory (`claude/projects/gh_<issue>` with `sources/` and `research/`), including claiming a dev slot and worktrees. This is the Saga convention for keeping the durable "why" record of a piece of work. |
| `/deploy` | Saga deploy procedure |

### Making things
| Skill | Use it when |
|---|---|
| `/design` | A visual canvas — mockups, screen flows, decks, one-pagers |
| `/dataviz` | Loads automatically when you ask for a chart |
| `/artifact-design` | Loads automatically when publishing a page |

### Housekeeping

| Skill | Use it when |
|---|---|
| `/fewer-permission-prompts` | You're approving the same things over and over |
| `/update-config` | Changing settings, permissions, or setting up automated hooks |
| `/loop` | Run something on a repeating interval ("check the deploy every 5 minutes") |
| `/schedule` | Scheduled cloud agents on a cron |

---

## How skills get invoked

Two ways, and the second is the one people miss:

1. **You type `/name`.** Explicit and predictable.
2. **Claude offers one.** Skills declare when they're relevant, and Claude
   suggests or loads them automatically when your task matches. You don't have to
   memorise the catalog — describing your problem in plain language often
   surfaces the right skill by itself.

So `/find-in-docs where is the synthetic org spec` and *"where is the synthetic
org spec documented?"* usually land in the same place.

---

## Skill vs plugin vs subagent vs MCP server

Worth twenty seconds, because the words get used interchangeably and they aren't:

| Thing | What it is |
|---|---|
| **Skill** | A procedure Claude follows. Markdown instructions, sometimes with scripts. |
| **Plugin** | A distributable bundle — usually several skills, sometimes MCP servers and agents. |
| **Subagent** | A separate Claude working in its own context on a delegated task, reporting back. Keeps noisy work out of your session. |
| **MCP server** | A connection to an external system, adding tools. See [04](04-mcp-servers.md). |

---

## Writing your own

If you find yourself explaining the same procedure to Claude repeatedly, that's a
skill waiting to be written. You do not need to be an engineer.

A skill is a folder with a `SKILL.md` in it. The frontmatter that matters:

```markdown
---
name: weekly-board-review
description: Pull open issues across Saga repos, group by theme, flag anything
  stalled more than two weeks. Trigger on "board review" or "what's stuck".
---

Then the procedure, in plain English, as numbered steps.
```

The `description` is load-bearing — it's how Claude decides the skill is relevant,
so write it as *when to use this*, not *what this is*.

Personal skills live in `~/.claude/skills/`. Saga's shared, distributable ones
live in the [saga-ed/claude-plugins](https://github.com/saga-ed/claude-plugins)
marketplace. There is also a local `skilgoreT-skills` working repo where several
of the Saga-specific skills below originate — ask skelly for access if you want
to contribute to those rather than keeping your own.

**The honest advice:** ask Claude to write it. "I keep asking you to do X, turn
that into a skill" works, and it will get the frontmatter right.

---

## Keeping them current

- `/plugin` → update from the manager
- Skills change as the repos change. If one gives you stale guidance, that's a
  bug worth filing — the skill is code, and it's maintained.

---

**Next**: [04 — MCP Servers](04-mcp-servers.md)
