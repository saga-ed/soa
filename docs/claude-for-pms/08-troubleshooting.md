# 08 — Troubleshooting

Real failures, in rough order of how often they bite. Most of these are not
Claude problems — they're environment problems that *look* like Claude problems.

---

## Claude problems

### "It's giving me worse answers than it did an hour ago"

Almost always context exhaustion. The session has filled up with a previous task
and is now reasoning around the edges of it.

- `/clear` — start fresh. Free, instant, and the right answer far more often than
  people expect.
- `/compact` — keep the thread but compress what's behind you.
- `/context` — see what's actually taking up room.

**Habit:** one session, one job. Switching tasks? New session.

### "It confidently told me something that turned out to be wrong"

Expected failure mode, not a malfunction. The fix is procedural, not technical:
for anything you'll act on or forward, ask **"show me"** — the file, the test
output, the issue link, the recording. Assertions are cheap; evidence is not.

### "It can't find a document I know exists"

Check whether the doc lives on an **unmerged branch**. Several Saga project docs
are written on their issue branch and only reach `main` when that branch merges —
so a search of your checkout won't see them. Ask Claude to look on the branch:

```
Search branch gh_421-ADM-period-golive for the go-live verification doc.
```

This has caught people out repeatedly. It's the single most common "the docs are
missing" cause at Saga.

### "A slash command isn't recognised"

The plugin providing it isn't installed in this project. See
[03 — Skills & Plugins](03-skills-and-plugins.md). Note that plugin installs must
be done from the **Claude Code terminal** — the VS Code integration hides some of
the interactive UI and the install will appear to do nothing.

### "It keeps asking permission for the same thing"

`/fewer-permission-prompts` — it scans what you keep approving and proposes an
allowlist. See [07 — Permissions & Safety](07-permissions-and-safety.md).

### "It asked approval for something that looked harmless"

Compound commands that combine `cd` with `git` always require approval, even when
the command itself is read-only (`cd ~/dev/iac && git status`). This is a
deliberate guard against bare-repository attacks, not a bug. Approve it if the
path is one you recognise.

---

## GitHub

### "Adding the issue to the board needs `read:project` scope"

Your `gh` token doesn't have the Projects scope. Two ways out:

1. Add it directly from the issue page — click **Projects** in the right sidebar.
2. Re-authenticate with the scope:
   ```bash
   gh auth refresh -s read:project,project
   ```

You may also simply not be a member of the org project. If `gh auth refresh`
doesn't fix it, ask skelly to add you to the board — this is a permissions
problem, not a tooling one.

### "gh: command not found"

```bash
brew install gh
gh auth login
gh auth setup-git
```

### "Permission denied (publickey)"

You're on SSH without keys set up. Easiest fix is to use HTTPS instead —
`gh auth setup-git` configures git to use your GitHub credentials. Or ask Claude
to walk you through SSH key setup.

---

## MCP servers

### "The Slack/Datadog/Figma tools aren't there"

`/mcp` shows every configured server and whether it's actually connected. A server
that's configured but failing usually means an expired token or a missing
environment variable — see [04 — MCP Servers](04-mcp-servers.md).

### "It worked yesterday and not today"

OAuth-based connectors expire. Re-authorise. Interactively-authenticated servers
also may not be available in background or scheduled runs at all — if a scheduled
job can't reach Slack, that's why.

### "The Slack tools can't search"

Depending on which Slack MCP you have, keyword search across the workspace may
not be exposed — only read-by-channel. If Claude tells you it can only read
channels by ID, believe it, and give it the channel or a date range to target.
This has produced confident false negatives before.

---

## Environment (synthetic dev / `ss`)

You probably won't hit these unless you're running the local stack, but if you
are, these three have each cost someone an afternoon:

### A service is behaving impossibly

Check whether it's running from a **stale checkout** — a slot service can be
running code from a different directory than the one you're editing:

```bash
ls -l /proc/<pid>/cwd
```

### An environment variable you set is being ignored

Ambient environment variables are **silently ignored** for anything the manifest
sets. Setting it in your shell does nothing. Check what the process actually got:

```bash
cat /proc/<pid>/environ | tr '\0' '\n'
```

### Specs fail against a service that "should" be current

`ss` doesn't pull non-set primaries, and the dashboard e2e tracks `main`.
Fast-forward-pull and restart before blaming the specs. Vite environment
variables need a full stack cycle, not a restart.

### ADM fixtures are missing

The `adm-a` / `adm-b` districts only seed under `ss stack seed full`. The roster
profile skips the programs and scheduling steps.

*(The `/ss` skill covers all of this properly — ask it rather than memorising.)*

---

## macOS specifics

Most Saga infrastructure documentation assumes Ubuntu. If you're on a Mac:

- The `/proc/<pid>/...` tricks above **don't exist on macOS**. Use `lsof -p <pid>`
  and `ps eww <pid>` instead.
- Install everything through Homebrew rather than `apt`.
- If a Saga runbook gives you an `apt install` line, the Homebrew equivalent is
  almost always `brew install <same-name>`. Ask Claude to translate it.

---

## When you're properly stuck

Ask Claude — describe the problem in plain language, paste the exact error, and
say what you were trying to do. That works more often than it has any right to.

If it's an environment or access problem rather than a usage problem, it's a
human question: ask in `#product-engineering`.

---

**Back to**: [README](README.md)
