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

Managing what you have:

```
/plugin list                                 # what's installed
/plugin enable  <name>@<marketplace>         # keep, but turn on/off
/plugin disable <name>@<marketplace>
/plugin uninstall <name>@<marketplace>
/plugin marketplace update <marketplace>     # refresh the catalog
```

`/plugin` on its own opens the manager UI — Discover, Installed, Marketplaces,
Errors.

`saga-soa` registers the `saga-tools` marketplace in its `.claude/settings.json`,
so **in this repo the Saga skills are already there**. You'll need to add it
yourself in repos that don't.

> **Read the catalog from GitHub, not from a local clone.** A checked-out copy of
> `claude-plugins` on your machine can be months stale — one on this machine lists
> 3 plugins when the marketplace actually has 18. `/plugin` and the GitHub repo
> are authoritative.

---

## What's available

Four marketplaces are worth knowing about.

### `saga-tools` — Saga's own (18 plugins)

[github.com/saga-ed/claude-plugins](https://github.com/saga-ed/claude-plugins#readme)

**The four that are genuinely PM-facing.** None are installed by default — install
them.

| Plugin | What it gives you |
|---|---|
| **saga-pm** | The big one. Wraps the `spm` CLI for cross-repo issue, epic, and release visibility. `/write-issue` (conventions-following issue creation, propose-then-apply), `/work-digest` (who's working on what, epic trees), `/release-digest` (merged-but-undeployed, what shipped, smoke-test focus), `/issue-triage` (bulk hygiene — orphan parenting, missing types, always user-approved) |
| **daily-planner** | `/plan-my-day` — turns open issues into an ordered, effort-aware checklist. Notably **floats issues filed by non-engineers as user-report proxies**. Read-only against GitHub; configured per user. |
| **ledger** | Definition-of-done discipline. `/ledger:frame` harvests a ticket's decisions and open questions, `/ledger:check-in` appends what surfaces mid-build, `/ledger:close` demands pasted evidence before calling it done. |
| **spec-driven-dev** | Specs with PMs or developers — see the skills table below |

**Also useful to a PM:**

| Plugin | What it gives you |
|---|---|
| **qa-review** | `/qa-review` — exploratory QA via charters. Pass a URL for black-box QA or a branch/PR for change-aware QA. Findings as Bug / Gap / Risk with repro steps. |
| **saga-dash-docs** | Reproducible **training and help-desk docs** for the saga-dash Reports forms — Playwright screenshot capture with visual diff, so screenshots regenerate as the UI changes |
| **saga-fleet** | `/fleet-map` — which repo is that thing in? ~40 Saga repos where directory names don't match what people call the product |
| **standup-deck** | `/standup-deck` — see [chapter 06](06-playbooks.md#7-build-the-standup-deck) |
| **documentation-system** | `/find-in-docs` and repo-wide doc health |
| **repo-tidy** | `/branch-tidy`, `/pr-status` — stale branches and conflicting PRs, with Slack-ready digests |

**Engineering-facing, listed so you know what the team is using:** `system-review`,
`compliance-audit`, `test-assistant`, `saga-iac`, `plugin-author`,
`personas-registry`, `claude-session-mgmt`, and `saga-dev-sec` (**Ubuntu only —
not applicable on a Mac**).

### `knowledge-work-plugins` — Anthropic's official PM plugin

Worth knowing about even though it isn't Saga-specific: Anthropic ships a
**product-management plugin** built for exactly this audience.

```
/plugin marketplace add anthropics/knowledge-work-plugins
/plugin install product-management@knowledge-work-plugins
```

| Command | What it does |
|---|---|
| `/write-spec` | Feature specs / PRDs — user stories, prioritisation, success metrics, scope |
| `/roadmap-update` | Roadmap planning — RICE, MoSCoW, Now/Next/Later, dependency mapping |
| `/stakeholder-update` | Pulls context from connected tools so you skip the weekly update grind |
| `/synthesize-research` | Interviews, surveys, tickets → themes, personas, opportunity sizing |
| `/competitive-brief` | Feature matrices, positioning, win/loss |
| `/metrics-review` | Metrics hierarchy, spike/drop investigation |
| `/brainstorm` | How Might We, JTBD, First Principles, Opportunity Solution Trees |

Its skills reference tool **placeholders** (`~~project tracker`,
`~~product analytics`, `~~chat`) that a `.mcp.json` binds to real services — so
you can point it at Saga's stack rather than the defaults. If you want a
Saga-flavoured version, forking this and swapping the connectors is a better
starting point than writing from scratch.



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

**Document skills** are worth adding too — the production `docx`, `pptx`, `xlsx`,
and `pdf` skills that power Claude's document handling:

```
/plugin install document-skills@anthropic-agent-skills
```

That's what you want when the deliverable has to be a real PowerPoint or Excel
file rather than a web page.

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

### Issues, epics and releases

Requires the **saga-pm** plugin (`/plugin install saga-pm@saga-tools`).

| Skill | Use it when |
|---|---|
| `/write-issue` | Filing an issue that follows Saga conventions — proposes first, applies on your approval |
| `/work-digest` | "Who's working on what?" — epic trees and per-repo digests |
| `/release-digest` | What's merged but not deployed; what shipped; where to focus smoke tests |
| `/issue-triage` | Bulk board hygiene — orphan parenting, missing types. Always user-approved. |
| `/plan-my-day` | Your morning checklist, ranked by priority and effort (**daily-planner** plugin) |

### QA and verification

| Skill | Use it when |
|---|---|
| `/assume-identity` | See the app as a specific user. **Prod is gated** — needs skelly's sign-off every time. |
| `/capture-evidence` | Record a GIF proving a fix works, file it, attach it to the issue |
| `/qa-review` | Exploratory QA against a URL, or change-aware QA against a branch/PR |
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
| `/open-doc` | Render a markdown file as a readable page in Chrome — **see the macOS note below** |

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

---

## macOS caveats

Most Saga tooling was written on Ubuntu. Three things do **not** work unmodified
on a Mac — worth knowing before you conclude a skill is broken:

| Skill / plugin | Problem | Workaround |
|---|---|---|
| **`/open-doc`** | Resolves the browser via `google-chrome` then `xdg-open` — neither exists on macOS. It also installs a freedesktop MIME handler, which is a Linux-only concept. | Needs a small patch to use `open -a "Google Chrome"`. Worth filing. |
| **`/standup-deck`** PDF export | Looks for `google-chrome` / `chromium` binaries | Set `CHROME=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome` — the script honours this override |
| **`saga-dev-sec`** | Ubuntu dev-machine security, `sudo apt` dependencies | Not applicable. Don't install it. |

`claude-session-mgmt` is partially portable — notifications work on both, but dock
badges and per-project desktop entries are Linux-only.

Absolute paths in shared config (`/home/skelly/...`) also need rewriting to
`/Users/<you>/...`; the `~/`-relative forms port cleanly.

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
