# 06 — PM Playbooks

Concrete recipes for the work Saga PMs actually do. Each one names the skill or
MCP server it leans on, gives you a prompt you can paste, and tells you what
"done" looks like.

Everything here uses tooling that is **already installed in the Saga setup** —
see [03 — Skills & Plugins](03-skills-and-plugins.md) if a `/command` below is not
recognised.

---

## 0. Start your day with a real checklist

**Skills:** `/plan-my-day` (daily-planner), `/work-digest` (saga-pm)

```
/plan-my-day
```

Sweeps open issues across the repos you own and returns an ordered, effort-aware
checklist. It deliberately **floats issues filed by non-engineers** as user-report
proxies — the things most likely to be real user pain rather than internal
cleanup. Read-only: it never edits, assigns, labels, or closes anything.

Then, for the wider picture:

```
/work-digest

Who's working on what across the ADM epics right now?
```

---

## 1. File a well-formed issue without opening GitHub

**Skill:** `/write-issue` (saga-pm) — or just describe it, as below.

**Why:** with a dozen repos, finding the right one in the UI is the slow part.

```
I hit a bug: taking attendance as a Site Director in the ADM Verification
program returns a 500. Repro: log in as <account>, Programs → ADM Verification
→ Attendance, pick today, hit Save. File this in the right repo, search for
duplicates first, and add it to the Saga Engineering board.
```

**What Claude does:** searches existing issues, picks the repo, drafts title +
repro steps + expected/actual, runs `gh issue create`, adds it to the board.

**Check before you approve:** the repo name and the body. You are signing your
name to it.

**Known trap:** adding an issue to an org Project board needs the `read:project`
scope on your `gh` token. If Claude reports it can't, see
[08 — Troubleshooting](08-troubleshooting.md).

---

## 2. Attach visual evidence to a bug or a fix

**Skill:** `/capture-evidence`

A GIF of the thing working — or failing — ends more debates than three paragraphs.

```
/capture-evidence

Record the attendance save failing on the ADM Verification program, then attach
it to I#1050 under a "Verification Evidence" heading.
```

**What Claude does:** drives Chrome, records the interaction as a GIF, files it
durably in the project's `research/`, commits it, and attaches it to the issue.

**Check:** watch the GIF before it gets attached. Make sure no real student data
is on screen.

---

## 3. See the app exactly as a specific user sees it

**Skill:** `/assume-identity`

**Why:** "works for me" is usually a permissions difference. Stop guessing.

```
/assume-identity

Sign in as a Site Director in the ADM Verification district on dev and show me
what the Reports tab looks like.
```

**Hard gate:** production impersonation is **not** self-serve. The skill requires
explicit sign-off from skelly every single time. Dev is unrestricted.

---

## 4. Find out what's actually going on across the board

**Skills:** `/slack:channel-digest`, `/slack:find-discussions`, plus `gh`

```
Give me a digest of #product-engineering and #team-rattler for the last three
days, then cross-reference anything mentioned there against open issues assigned
to me. What needs my decision today?
```

Or, when you know a decision was made but not where:

```
/slack:find-discussions

Where did we land on whether deactivated periods still count in ADS reports?
```

**Why this beats scrolling:** Slack search matches words; this matches meaning
across channels and then reconciles against issue state.

---

## 4b. What shipped, and what's waiting to ship

**Skill:** `/release-digest` (saga-pm)

```
/release-digest
```

Tells you what's **merged but not yet deployed**, what actually shipped in the
last release, and where to focus smoke tests. This is the answer to "is the fix
live yet?" — a question that costs a surprising amount of Slack traffic, and one
where Claude will otherwise confidently conflate *merged* with *deployed*.

Companion: `/issue-triage` for bulk board hygiene — orphan parenting, missing
types. Always proposes before applying.

---

## 5. A stakeholder-ready digest of a spec

**Skill:** `/spec-status`

This skill is explicitly PM-aware — it adapts its output for a PM audience rather
than a developer one.

```
/spec-status

I have a stakeholder review in an hour on the session-based ADM go-live. Give me
a PM-readable digest of what the spec guarantees, what's covered by tests, and
what's still open.
```

It will also generate a **manual test plan** from a spec, which is the fastest
route from "spec exists" to "I can actually check this myself".

---

## 6. Turn a rough intent into a real spec

**Skill:** `/spec-workshop`

Designed to work from PM language, not technical spec language. Good when the
feature is still being defined.

```
/spec-workshop

I want to define the behaviour for grouping sections into a single period —
"group by". Let's sketch the cases before committing to a spec.
```

Companion skills: `/spec-triage` at sprint boundaries ("which drafts are ready to
promote?"), `/spec-review` to find coverage gaps.

---

## 7. Build the standup deck

**Skill:** `/standup-deck`

```
/standup-deck
```

**What it does:** interrogates GitHub and messages your other active Claude
sessions to work out what actually moved, then publishes a dark terminal-style
slide deck as an Artifact — green for what matters, brick red for blockers. It
produces a share-safe copy and an optional PDF.

**What it deliberately does not do:** post to Slack or edit issues. You stay in
control of anything outward-facing.

---

## 8. Draft an announcement you'd be happy to send

**Skill:** `/slack:draft-announcement`

```
/slack:draft-announcement

We're deploying the ADM period-based go-live to prod on Thursday. Audience is
#product-engineering. Mention the deactivated-period reporting caveat.
```

Saves as a **draft**. Nothing is sent without you pressing send yourself.

---

## 9. "Where is this documented?"

**Skill:** `/documentation-system:find-in-docs`

```
/find-in-docs

Where is the synthetic dev district specified, and who owns it?
```

Searches the CLAUDE.md hierarchy structurally rather than brute-force grepping —
much better than `grep` when you want the *owner* of a thing, not every mention.

---

## 10. Check whether production is actually healthy

**MCP:** Datadog

```
Search Datadog logs for 500s from ads-adm-api in the last 6 hours, group them by
endpoint, and tell me whether the attendance save path is affected.
```

Also useful: `search_datadog_incidents` for whether something is already a known
incident before you file a duplicate, and `get_datadog_dashboard` to read a
dashboard without opening one.

The Datadog MCP ships **skill guides** — Claude loads domain guidance
automatically before querying. If you get an unhelpful answer, ask it to load the
relevant Datadog skill first.

See [04 — MCP Servers](04-mcp-servers.md) for setup.

---

## 11. Read Figma comps as data, not as pictures

**MCP:** Figma

```
Pull the Scheduling UI Redesign Figma file, node 2253-6916, and list every column
shown in the roster table along with Emma's annotations.
```

**Why it matters:** you get node IDs and verbatim annotation text you can paste
straight into an issue, instead of screenshotting and describing.

**The high-value variant** — this is what Anthropic's own Product Design team
found most useful, and it's cheap to add:

```
Walk this comp and map the error states, logic flows, and system statuses.
What edge cases does it not account for?
```

Finding edge cases at design time instead of discovering them in development is
the single best return on pointing Claude at a Figma file.

---

## 12. Screenshots and walkthrough videos for help articles

**Extension:** Claude in Chrome. **Tooling:** `tools/walkthrough-video/` in this repo.

```
Walk the login → programs → sessions journey in the synthetic dev environment and
capture a screenshot at each step. Save them somewhere I can drop into a help
article.
```

For a narrated version, `saga-soa` has dedicated tooling — see
[`docs/how-to-narrated-walkthrough-video.md`](../how-to-narrated-walkthrough-video.md).

---

## Discovery and prioritisation

Everything above is *execution* — the work that follows a decision. This section
is the half that precedes it, and it runs on Anthropic's official PM plugin
rather than Saga tooling:

```
/plugin marketplace add anthropics/knowledge-work-plugins
/plugin install product-management@knowledge-work-plugins
```

### 12a. Reprioritise the roadmap

```
/roadmap-update

Re-rank the back-to-school epics with RICE. Flag anything whose dependencies
mean it can't start when the current plan says it does.
```

Supports RICE, MoSCoW, Now/Next/Later, quarterly themes, OKR-aligned formats, and
dependency mapping.

### 12b. Synthesise user research

The one with the clearest Saga analogue — tutor and coach feedback, focus-group
notes, support tickets.

```
/synthesize-research

Here are the notes from three focus groups plus the last 40 issues filed by
site directors. Find the themes, size the opportunities, and keep an evidence
trail back to the source for each one.
```

Handles interviews, surveys, and tickets → thematic analysis, affinity mapping,
personas, opportunity sizing.

### 12c. Review product metrics

**This is not the same as the Datadog playbook.** Datadog tells you whether the
service is *healthy*; this tells you whether the product is *working*.

```
/metrics-review

Walk the North Star down to L1 and L2. What moved this month, what's off target,
and which segment explains the drop?
```

### 12d. Use Claude as a sparring partner

```
/brainstorm

How might we make section-to-period mapping comprehensible to a first-time site
director? Push back on my framing before you generate options, and tell me the
cheapest experiment to test the riskiest assumption.
```

Supports How Might We, JTBD, First Principles, and Opportunity Solution Trees.
Asking it to challenge the premise first is the part people skip and shouldn't.

### 12e. Competitive briefs

```
/competitive-brief
```

Feature comparison matrices, positioning, win/loss.

---

## 12f. Triage a pile of things at once

**Why:** most playbooks above handle one item. This one handles hundreds.

```
Here's a CSV of every issue filed by site directors this term. Group them by
underlying cause, tell me which five causes account for the most reports, and
draft a one-line response for each group.
```

Claude will fan this out across subagents rather than grinding serially. This is
where the leverage is on anything that currently means an afternoon of
copy-pasting.

---

## 13. Publish analysis as something you can send someone

**Skills:** `/design`, or Artifacts directly.

```
Take the findings above and publish them as a private page I can share with Tom —
one section per finding, with the evidence links.
```

Artifacts start **private**. You choose whether to share. See
[05 — Design & Deliverables](05-design-and-deliverables.md).

---

## 14. Keep something you'll want again

**Skills:** `/capture-response`, `/open-doc`

```
/capture-response

Pin that last answer as "ADM reporting — deactivated period behaviour".
```

Then later, from any session: `/capture-response` → "show me my pins". This is the
antidote to "Claude explained this perfectly last Tuesday and it's gone".

`/open-doc <path>` renders any markdown file as a styled page in Chrome — use it
on anything in this guide.

---

## The phrase book

Things you can say, and what happens. Adapted from the original Saga onboarding
materials and extended for PM work.

| What you say | What Claude does |
|---|---|
| "What changed in this repo this week?" | Reads `git log`, summarises by theme |
| "File this as an issue in the right repo" | Finds repo, checks dupes, `gh issue create` |
| "Is this a duplicate of anything open?" | Searches issues across the org |
| "Show me what a Site Director sees" | `/assume-identity` in dev |
| "Record a GIF of this failing" | `/capture-evidence` |
| "Digest #product-engineering for 3 days" | `/slack:channel-digest` |
| "Where did we decide X?" | `/slack:find-discussions` |
| "Where is X documented?" | `/find-in-docs` |
| "PM digest of this spec" | `/spec-status` |
| "Sketch the cases for this feature" | `/spec-workshop` |
| "What should I work on today?" | `/plan-my-day` |
| "What's merged but not deployed?" | `/release-digest` |
| "Who's working on what?" | `/work-digest` |
| "Build today's standup deck" | `/standup-deck` |
| "Draft an announcement about the deploy" | `/slack:draft-announcement` (draft only) |
| "Are we seeing 500s in prod?" | Datadog MCP log search |
| "What does this Figma node specify?" | Figma MCP |
| "Publish this as a page I can share" | Artifact, private by default |
| "Pin this answer" | `/capture-response` |
| "Open that doc so I can read it" | `/open-doc` |
| "Start over, forget the last thing" | `/clear` |

---

**Next**: [07 — Permissions & Safety](07-permissions-and-safety.md)
