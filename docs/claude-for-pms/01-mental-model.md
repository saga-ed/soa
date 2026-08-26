# 01 — The Mental Model

> Read this one first. Everything else in this guide is mechanics; this chapter is
> the part that determines whether the mechanics pay off.

## The division of labour

**You own the *what* and the *why*. Claude owns the *how*.**

That single sentence is the whole model. You decide what needs to exist, what
"correct" looks like, and whether the result is actually right. Claude handles the
commands, the file edits, the API calls, the git plumbing, and the search.

This is a real shift from using a chat assistant. In chat, you ask a question and
judge an answer. Here, you state an intent and Claude *takes actions in your real
systems* — your checkout, your GitHub, your Slack, your browser. The quality of
your intent, and the rigour of your verification, are now the two things that
matter most.

What follows from that:

- **You do not need to know the commands.** You need to know what outcome you
  want and how you would recognise it.
- **You do need to check the work.** Claude is fast and usually right, which is
  precisely why unchecked output is dangerous — the failure mode is a plausible
  wrong answer, not an obvious one.
- **Vague intent produces vague work.** "Look at the attendance bug" gets you a
  wander. "Reproduce the 500 on the attendance tab for a Site Director in the ADM
  Verification program, and tell me whether it's the same root cause as I#1050"
  gets you an answer.

## "What am I safe to say yes to?"

This is the most common question from PMs picking up Claude Code, and it deserves
a direct answer rather than a shrug.

When Claude wants to do something consequential it stops and asks. The prompt
tells you the exact command or file it wants to touch. Your job is to read the
*target*, not the verb.

**Safe to approve without much thought — reading and searching:**

| Shape | Examples |
|---|---|
| Reading files | `cat`, `head`, `sed -n`, opening a file |
| Searching | `grep`, `rg`, `find`, `gh issue list` |
| Status checks | `git status`, `git log`, `git diff`, `gh run list` |
| Running tests | `pnpm test`, `npx playwright test` |

These can waste time. They cannot lose work.

**Read carefully before approving — writing:**

| Shape | What to check |
|---|---|
| `git commit`, `git push` | Which branch? Never `main`. |
| File writes / edits | Is the path inside the project you meant? |
| `gh issue create`, `gh pr create` | Which repo? Is the body what you'd sign your name to? |
| Slack sends, emails | **Outward-facing.** Who receives this? |

**Stop and ask a human:**

| Shape | Why |
|---|---|
| Anything against **production** | Blast radius. Saga gates prod impersonation explicitly. |
| `rm`, `git reset --hard`, `--force`, dropping a table | Destructive and often irreversible. |
| Anything touching student data | PII. See [07 — Permissions & Safety](07-permissions-and-safety.md). |
| Credentials, tokens, `.env` files | Never paste a secret into a chat, ever. |

The general rule: **reversible and internal → approve. Irreversible or
outward-facing → read it twice.** If you cannot tell which it is, say no. Claude
will explain what it was trying to do and you can approve the next attempt with
your eyes open. Saying no costs you fifteen seconds; saying yes to the wrong
thing can cost an afternoon.

You can also make this decision *once* instead of every time — see
[07 — Permissions & Safety](07-permissions-and-safety.md) for allowlisting the
read-only commands you approve constantly.

## Context is the resource you're managing

Claude reads your project to understand it. What it has read is its *context*, and
context is finite. Most disappointing sessions are context problems wearing a
different hat.

Three practical habits:

1. **One session, one job.** Filing a bug and drafting a launch memo in the same
   session makes both worse. Start a new session (`/clear`) when you switch
   tasks. It is free.
2. **Point at the thing.** "Read `docs/claude-for-pms/README.md` and then…" beats
   hoping Claude finds it. Paste issue numbers, file paths, URLs. Precision in,
   precision out.
3. **`CLAUDE.md` is the project's memory.** Every repo has one; it is how Claude
   knows Saga conventions without being told each time. When Claude keeps getting
   a convention wrong, the fix is usually a line in `CLAUDE.md`, not a longer
   prompt.

## Calibrating your expectations

Two failure modes sit at opposite ends, and PMs tend to swing between them.

**Over-trust.** Claude writes with total confidence whether or not it is right.
It will cite a file that does not exist, or state that a fix is deployed when it
is merged but not released. The discipline: for anything you will act on or
forward to someone else, ask *"show me"* — the file, the test output, the issue
link, the screenshot. Evidence, not assertion. `/capture-evidence` exists for
exactly this reason.

**Under-trust.** The opposite trap is treating Claude as a fancy autocomplete and
hand-doing the parts it is genuinely better at — reading forty issues, cross-
referencing three repos, drafting the first version of anything. That is where
the hours actually are.

And a calibration note from real use: agentic tooling makes hard work *faster*,
not *easy*. A gnarly bug is still a gnarly bug. What changes is that you can hold
more of it in your head at once, and you stop losing an hour to "which repo was
that in".

## Which Claude am I even using?

There are several surfaces and they are genuinely easy to confuse. Full detail is
in [02 — Setup](02-setup-macos.md); the short version:

- **Claude Code** — the agentic tool that works in a *checkout on your machine*.
  Runs commands, edits files, drives git. This guide is mostly about this.
- **Claude Desktop / Cowork** — the desktop app. Great for research, documents,
  and browser work; weaker when the job is "operate on this repo".
- **claude.ai** — the web chat you already know.
- **Claude Design** — visual canvases and decks. See
  [05 — Design & Deliverables](05-design-and-deliverables.md).

They share your subscription. Choosing between them is mostly: *does the work
live in a repo?* If yes, Claude Code. If it lives in documents, a browser, or
your head, the Desktop app is often the nicer place to start.

---

**Next**: [02 — Setup on macOS](02-setup-macos.md)
