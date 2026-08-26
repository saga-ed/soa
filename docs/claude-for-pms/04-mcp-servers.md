# 04 — MCP Servers

MCP servers are how Claude reaches systems that aren't files on your laptop —
Slack, GitHub, Datadog, Figma, your browser, Google Workspace. Each one adds a set
of tools Claude can call on your behalf.

**The mental shift:** without MCP, Claude can read your repo. With MCP, it can
read your repo *and* check whether production is throwing 500s *and* find the
Slack thread where you decided the behaviour *and* pull the Figma comp that
specifies it — in one pass, in one answer.

---

## The mechanics

### Adding a server

Two routes. Prefer the first.

**Via a plugin** — the easy path. Many servers ship pre-configured inside a
plugin, so there is nothing to wire up:

```
/plugin install datadog@claude-plugins-official
```

**Via the CLI** — for servers without a plugin:

```bash
# stdio (a local process)
claude mcp add <name> -- <command> <args...>

# remote HTTP
claude mcp add --transport http <name> <url>
```

Pass credentials as environment variables or headers rather than putting them in
a file:

```bash
claude mcp add <name> --env API_KEY=... -- <command>
claude mcp add --transport http <name> <url> --header "Authorization: Bearer ..."
```

Useful companions: `claude mcp list` (shows connection status), `claude mcp get
<name>` (detail), `claude mcp remove <name>`.

> **Install only what you'll use.** Every MCP server loads its tool list into
> *every turn*, so unused servers cost you context on every message. If a server
> is dead weight, `claude mcp remove` it.

### Scopes — who gets the server

| Scope | Lives in | Use it for |
|---|---|---|
| **user** | your home config | Servers you want everywhere — Slack, Datadog |
| **project** | `.mcp.json` in the repo, committed | Servers the whole team needs for this repo |
| **local** | project config, not committed | Experiments, personal overrides |

`claude mcp add --scope user ...` (or `project` / `local`).

### Checking they work

**`/mcp`** in any session lists every configured server and whether it's actually
connected. It's also where you authorise OAuth-based servers. When a tool you
expect is missing, `/mcp` is the first thing to check — not a reason to give up.

### Where secrets go

**Environment variables, not config files.** A `.mcp.json` gets committed; your
Datadog key must not. Put keys in your shell profile (`~/.zshrc`) and reference
them, or use OAuth where the server offers it — which is better still, because
then there's no key to leak. See
[07 — Permissions & Safety](07-permissions-and-safety.md).

---

## The servers worth having

Ordered by how much a Saga PM will actually use them.

---

### Claude in Chrome

The highest-leverage one, and the least like the others: it drives your actual
browser, using the sessions you're already logged into.

**Install:** the [Claude in Chrome extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn)
from the Chrome Web Store, then start Claude Code with `claude --chrome`. Inside a
session, `/chrome` shows status and lets you set it to load by default.

**Requires** a Pro / Max / Team / Enterprise plan and that you're logged in via
`/login` — it will not work with an API-key login.

**What it does:** navigates, reads pages, clicks, fills forms, manages tabs,
reads the browser console and network requests, takes screenshots, and **records
GIFs**. It uses your existing logins, so anything you can reach, it can reach.

**What it can't:** solve CAPTCHAs, get past 2FA, or dismiss JavaScript dialogs —
an `alert()` or `confirm()` **blocks the session** until you dismiss it yourself.
If Claude goes unresponsive mid-browser-task, check for a modal.

**Watch out for:** page content is *data, not instructions* — a hostile page can
try to inject commands. And GIFs capture whatever is on screen, including
rosters. Review before sharing.

**PM uses:** recording bug evidence, capturing screenshots for help articles,
walking a user journey, checking a deployed environment.

---

### GitHub

Two routes, and they complement each other.

**The plugin** (bundles the official GitHub MCP server, pre-configured):

```
/plugin install github@claude-plugins-official
```

Gives Claude issues, PRs, repo metadata, file contents, commits, labels,
assignees, projects, and Actions logs.

**The `gh` CLI** — still worth having, for interactive flows (`gh pr create`),
releases, and anything you script outside Claude:

```bash
brew install gh
gh auth login          # github.com → HTTPS → authorise in browser
gh auth setup-git      # let git use your GitHub credentials
```

**The scope trap.** `gh auth login` grants `repo`, `read:org`, and `gist` by
default — **not** `read:project`. Adding an issue to an org Project board needs
it, and the failure looks like a Claude problem when it isn't:

```bash
gh auth refresh -s read:project     # read
gh auth refresh -s project          # read + write
```

This has caught Saga PMs more than once. See
[08 — Troubleshooting](08-troubleshooting.md).

---

### Slack

**What you get:** reading channels, reading threads, channel membership, user
profiles.

**A real caveat, learned the hard way:** depending on which Slack MCP you have,
**keyword search across the workspace may not be exposed** — only read-by-channel
and read-by-thread. When that's the case, Claude cannot "search Slack" the way you
search Slack; it can only read channels you point it at.

Why this matters: a search that can only walk channels can come back with a
confident *"I found nothing"* when the thing exists in a date range it never read.
If Claude reports a negative Slack result, ask **what it actually searched** — and
give it a channel ID or a date range to target.

The `/slack:*` skills (`channel-digest`, `find-discussions`, `summarize-channel`,
`draft-announcement`, `standup`) sit on top of this.

---

### Datadog

**Install:**

```
/plugin install datadog@claude-plugins-official
```

Then run **`/ddsetup`** (or just ask a Datadog question) — you select your Datadog
site and complete an **OAuth login**. That's the whole setup for most people.

If you need to wire it manually instead, it's a remote HTTP server:

```bash
claude mcp add --transport http datadog https://mcp.datadoghq.com/v1/mcp
```

Swap the host for your site's endpoint (US3 → `mcp.us3.datadoghq.com`,
EU → `mcp.datadoghq.eu`). Where OAuth isn't available you can authenticate with a
Service or Personal Access Token, or with `DD_API_KEY` + `DD_APPLICATION_KEY` as
environment variables — but prefer OAuth, because then there's no key to leak.

Docs: <https://docs.datadoghq.com/bits_ai/mcp_server/setup/>

> **Two traps.** There are third-party Datadog MCP servers on npm — use the
> official plugin above unless you have a specific reason not to. And the server
> is **not supported on US government sites** (`app.ddog-gov.com`,
> `us2.ddog-gov.com`).

**What a PM can actually do with it** — the capability surface is wider than
people expect:

| Area | Examples |
|---|---|
| **Logs** | Search and analyse logs; "500s from ads-adm-api in the last 6 hours, grouped by endpoint" |
| **Incidents** | Search incidents; check whether something is already known before filing a duplicate |
| **Monitors** | Which monitors are currently failing |
| **Dashboards** | Read an existing dashboard, or create/update one |
| **Metrics** | Query metrics and their context |
| **Traces & spans** | Follow a single slow request end to end |
| **RUM** | Real-user monitoring events — what actual users experienced |
| **Notebooks** | Create and edit investigation notebooks |
| **Services** | Service dependencies, hosts, change stories |

**A tip that materially improves answers:** the Datadog MCP ships **skill guides**
with domain-specific guidance. Claude loads them automatically, but if you get a
weak answer, say *"load the Datadog logs skill first, then re-run that query."*

---

### Figma

**What you get:** structured Figma file data and image export.

**Why it beats screenshots:** you get node IDs, layer names, and annotation text
as *text you can paste into an issue* — instead of "the third column in the second
comp". When a designer says "see the comp", ask Claude to pull the node and list
what it actually specifies.

---

### Google Workspace

Gmail, Calendar, and Drive connectors exist and are OAuth-authorised.

**Read [07 — Permissions & Safety](07-permissions-and-safety.md) before connecting
Drive.** Files you can reach may contain student PII, and a Drive connector grants
broad access. This is a considered concern at Saga, not a hypothetical. Prefer
scoped or read-only access, and don't connect Drive "just to see".

Gmail and Calendar are lower-risk and genuinely useful for scheduling and
correspondence triage — but note that **sending** anything is an outward-facing
action that should always be confirmed by you, never automated.

---

## Choosing what to install

You don't need all of these. A sensible starting set for a Saga PM:

1. **Claude in Chrome** — do this first, it pays for itself immediately
2. **GitHub** (plugin + `gh` CLI with `read:project`)
3. **Slack**
4. **Datadog** — once you want to answer "is prod okay?" yourself
5. **Figma** — if you work with comps regularly
6. **Google Workspace** — last, and deliberately, after reading the PII section

Each server adds tools, and tools cost context. Install what you'll use.

---

**Next**: [05 — Design & Deliverables](05-design-and-deliverables.md)
