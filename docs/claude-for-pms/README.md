# Claude for Saga PMs

Everything a Saga product manager needs to get maximum value out of the Claude
ecosystem — the mental model, the setup, the skills and MCP servers worth having,
and the playbooks that turn all of it into finished work.

**Audience:** Saga PMs and other non-engineers who work in and around the
codebase — filing issues, running QA, writing specs, building decks, chasing
decisions. On macOS. No prior terminal experience assumed.

**Not** an engineering onboarding. If you're a Saga engineer, start at
[`docs/GETTING-STARTED.md`](../GETTING-STARTED.md) instead.

---

## The one-line version

> **You own the *what* and the *why*. Claude owns the *how*.**

You decide what needs to exist and whether the result is right. Claude handles the
commands, the searching, the file edits, the git plumbing, and the API calls.

---

## Start here

Read these two, in order, before anything else. Together they're about twenty
minutes and they're the difference between this working and this frustrating you.

1. **[01 — The Mental Model](01-mental-model.md)** — how to think about the tool,
   what's safe to approve, and how to manage context. Includes a direct answer to
   the question everyone asks first: *"what am I safe to say yes to?"*
2. **[02 — Setup on macOS](02-setup-macos.md)** — install, auth, and your first
   session. Also untangles Claude Code vs Claude Desktop vs Cowork vs
   claude.ai/design, which are genuinely easy to confuse.

Then dip into the rest as you need it.

---

## The full map

| Chapter | What's in it |
|---|---|
| [01 — The Mental Model](01-mental-model.md) | Division of labour, the approve/deny decision table, context management, calibrating trust |
| [02 — Setup on macOS](02-setup-macos.md) | Install, authentication, terminal basics, the different Claude surfaces |
| [03 — Skills & Plugins](03-skills-and-plugins.md) | The 18-plugin `saga-tools` marketplace, Anthropic's official PM plugin, which skills a PM actually uses, macOS caveats, writing your own |
| [04 — MCP Servers](04-mcp-servers.md) | Slack, GitHub, Datadog, Figma, Chrome, Google — what they give you and how to set each up |
| [05 — Design & Deliverables](05-design-and-deliverables.md) | Artifacts, Claude Design canvases, charts, diagrams — turning work into something you can send |
| [06 — PM Playbooks](06-playbooks.md) | 16 concrete recipes, plus a phrase book of things you can say |
| [07 — Permissions & Safety](07-permissions-and-safety.md) | Permission fatigue, the Saga prod gate, student PII, prompt injection, what leaves your machine |
| [08 — Troubleshooting](08-troubleshooting.md) | The failures that actually happen here, in order of frequency |

---

## What you get out of it

A rough sense of what changes, so you can judge whether the setup time is worth it:

- **Filing and triaging issues** across a dozen repos without opening GitHub, with
  duplicate-checking and board placement handled.
- **Bug reports that land** — with a recorded GIF of the failure attached, and the
  app viewed as the actual affected user role.
- **Answers to "where did we decide that?"** pulled from Slack, issues, and docs
  at once, instead of scrolling.
- **Stakeholder-ready specs and decks** generated from what the code and the board
  actually say, not from memory.
- **Production health checks** you can run yourself instead of asking an engineer.

The consistent theme: the work that used to mean holding four browser tabs and
three repos in your head gets handed off, and you spend your time on judgement
instead of retrieval.

---

## A note on expectations

Agentic tooling makes hard work **faster**, not **easy**. A gnarly bug is still a
gnarly bug; a contested roadmap decision is still contested. What changes is that
you can hold more of the problem at once and you stop losing an hour to "which
repo was that in".

It will also, occasionally, be confidently wrong. [Chapter 01](01-mental-model.md)
covers how to calibrate for that. The short version: for anything you'll act on or
forward, ask to be *shown*, not told.

---

## Keeping this current

The Claude ecosystem moves fast — commands, plugins, and available MCP servers
change. If something here is wrong or stale, fix it: this doc lives in the repo,
so a PR is the right move.

Contributions especially welcome for:

- New playbooks that worked for you ([06](06-playbooks.md))
- Failures that cost you time ([08](08-troubleshooting.md))
- Skills you built that others should have ([03](03-skills-and-plugins.md))

---

## Related reading

- [`docs/GETTING-STARTED.md`](../GETTING-STARTED.md) — the engineering setup for
  this repo
- [`docs/how-to-narrated-walkthrough-video.md`](../how-to-narrated-walkthrough-video.md)
  — generating narrated demo videos of any Saga frontend
- [saga-ed/claude-plugins](https://github.com/saga-ed/claude-plugins#readme) — the
  `saga-tools` marketplace catalog
