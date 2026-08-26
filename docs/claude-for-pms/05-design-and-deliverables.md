# 05 — Design & Deliverables

Most PM work ends in something someone else has to read: a one-pager, a deck, a
status page, a chart. This chapter is about getting from "Claude figured it out"
to "here is a link I can send Tom".

## The three surfaces

| You want… | Use | Result |
|---|---|---|
| A page someone can read and comment on | **Artifact** | Private URL on claude.ai, shareable when you choose |
| A visual layout you want to tweak by hand | **Claude Design canvas** | Multi-artboard canvas with a visual editor |
| A chart or dashboard | **`/dataviz`** then publish as an Artifact | Consistent, accessible, light+dark |

The decision is mostly: *is the output prose, or is it layout?* Prose and tables →
Artifact. Boxes, arrows, screens, posters → Design canvas.

---

## Artifacts

An Artifact is a web page Claude publishes for you. It is **private by default** —
it gets a URL, but nobody sees it until you share it.

Ask for one in plain language:

```
Publish that as a page I can share with the leadership team.
```

**What they're good for at Saga** — this is exactly how the existing internal
one-pagers get made: standup decks, the deploy strawman, the back-to-school
ledger, a re-entry brief for someone returning from leave. Anything where the
alternative is a Google Doc nobody opens.

**Things worth knowing:**

- **They update in place.** Ask Claude to revise it and the same URL gets the new
  version. Don't re-publish a fresh copy — you'll fragment the link.
- **They keep a version history**, so a bad edit is recoverable.
- **People can comment** on a published Artifact, and you can have Claude read
  and reply to those comment threads.
- **They can be interactive** — a poll, a sign-up sheet, a checklist that
  remembers what people ticked, a page that reads live data. Just ask for the
  behaviour you want; Claude will work out whether it's possible.
- **Finding old ones:** `/artifacts` in the terminal lists them, or the gallery at
  [claude.ai/code/artifacts](https://claude.ai/code/artifacts).

**Rule of thumb:** if you're about to paste a long answer into Slack, publish it
as an Artifact and paste the link instead. It stays readable, it stays editable,
and it doesn't scroll away.

---

## Claude Design

[claude.ai/design](https://claude.ai/design) is the visual surface — a canvas with
multiple artboards that you can pan, zoom, and edit directly. Click an element,
change it in a properties panel, edit text inline, undo, save.

From a Claude Code session, `/design` drafts the canvas for you:

```
/design

A five-slide deck explaining the move from the current ADS/ADM architecture to
the HTTP-only proposal. Pull the actual service names from this repo.
```

**Why this matters for a PM:** it can build from the codebase. You are not
describing an architecture from memory into a slide tool — Claude reads the repo
and draws what is actually there. The same applies to screen flows: it can look at
the real UI and lay out the journey.

**Good fits:** UI mockups and screen flows, one-pagers, posters and flyers,
launch decks, anything you'd otherwise fight Google Slides over.

**Subscription:** included with Pro, Max, Team, and Enterprise at no extra cost.
Not available on the free tier. Whether the visual *editor* saves for your account
depends on your plan — if saving isn't enabled you still get a view-and-export
preview (PNG/PDF) of the draft.

### The sharing trap

Worth knowing before you promise someone a link. An **editable Claude Design
canvas can only be shared inside the org.** Its payload embeds editor code, and
any version carrying those references is refused for public sharing — you'll get
*"This version can't be shared publicly."* Declaring no capabilities does not
help.

So a deck that needs to go to anyone outside Saga needs **two copies**: the
editable canvas for internal iteration, and a plain self-contained HTML copy for
sharing. The `/standup-deck` skill does this automatically — it publishes both. If
you're building a canvas by hand and it needs an external audience, plan for it.

One more limitation: **headless runs (`claude -p`) cannot publish** — no Artifact
tool, and the Skill tool won't invoke `design`. Publishing needs an interactive
session.

---

## Charts

Ask for a chart and Claude will load the `/dataviz` guidance automatically — it
covers palettes that stay legible in light and dark, accessible colour choices,
and consistent chart forms. You don't need to invoke it explicitly.

```
Chart the open-issue count by repo over the last six weeks. I want it readable
in the deck.
```

What you should push back on: unlabelled axes, six near-identical colours, and
pie charts with more than four slices. Ask for a different form; it will oblige.

---

## Diagrams

For architecture and flow diagrams inside a page, Claude uses Mermaid, which
renders natively in Artifacts. You can just ask:

```
Add a sequence diagram showing how an attendance save travels from the dash
through to ads-adm-api.
```

If the diagram comes out as an unreadable hairball, say so — "flatten this to
five boxes, I want the shape not the detail" is a legitimate and effective
instruction.

---

## What not to publish

Artifacts are real web pages. Before publishing, check:

- **No student PII.** Names, emails, IDs. Use screen names and internal user IDs.
- **No credentials**, ever — not in a page, not in a screenshot.
- **Nothing that impersonates** a real person or organisation, and no fabricated
  records presented as genuine.

If in doubt, publish it and *don't share the link* — private is the default for a
reason. See [07 — Permissions & Safety](07-permissions-and-safety.md).

---

**Next**: [06 — PM Playbooks](06-playbooks.md)
