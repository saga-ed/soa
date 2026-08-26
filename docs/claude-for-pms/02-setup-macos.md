# 02 — Setup on macOS

Half an hour, most of it waiting for downloads. Nothing here requires prior
terminal experience.

---

## First: which Claude are you installing?

These are genuinely easy to confuse, and picking the wrong one is the most common
false start. All of them use the same subscription.

| Surface | What it is | Best for |
|---|---|---|
| **Claude Code (terminal)** | The agentic tool, run as `claude` in a terminal | Working in a repo. Most of this guide. |
| **Claude Code (desktop app)** | The same tool with a graphical interface, no terminal | Same work, if the terminal puts you off |
| **Claude Code (IDE extension)** | VS Code / JetBrains integration | If you already live in an editor |
| **Claude Desktop** | The general Claude app, including the **Cowork** tab | Research, documents, browser work |
| **claude.ai** | The web chat | Quick questions |
| **[claude.ai/design](https://claude.ai/design)** | Visual canvases and decks | See [chapter 05](05-design-and-deliverables.md) |

**Choosing:** does the work live in a repo? Then Claude Code. Does it live in
documents, a browser, or your head? Claude Desktop is often the nicer start.

> **A correction worth flagging**, since older Saga materials get this wrong:
> "download the Claude Code Desktop App from claude.ai/download" is not right —
> `claude.ai/download` gets you **Claude Desktop**, a different product. The
> Claude Code desktop app has its own download, linked below.

---

## Step 1 — Requirements

- **macOS 13.0 or later**, 4 GB+ RAM
- **A paid plan**: Pro, Max, Team, or Enterprise. **The free Claude.ai plan does
  not include Claude Code.**

---

## Step 2 — Install

Open **Terminal** (`Cmd + Space`, type "Terminal", Enter) and pick one:

**Native installer — recommended.** Auto-updates in the background:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Homebrew**, if you already use it. Note it does *not* auto-update:

```bash
brew install --cask claude-code
```

Upgrade later with `brew upgrade claude-code`.

**Prefer no terminal at all?** There's a desktop app:
[download for macOS](https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect).
It runs the same Claude Code, with a graphical interface. Everything in this guide
still applies — the slash commands are identical.

### Verify

```bash
claude --version
```

You should get something like `2.1.211 (Claude Code)`. If instead you get
`command not found`, open a **new** terminal window first — the installer changes
your `PATH` and existing windows don't pick it up.

For a fuller check:

```bash
claude doctor
```

This prints installation and settings diagnostics without starting a session.
It's the first thing to run whenever something seems broken.

---

## Step 3 — Log in

From any folder:

```bash
claude
```

The first run opens your browser to authenticate. Sign in with the account that
holds your Claude subscription.

> Use the browser login, **not** an `ANTHROPIC_API_KEY`. Some features —
> notably the Chrome integration — are disabled for API-key logins.

---

## Step 4 — Install the supporting tools

Two things make Claude Code dramatically more useful at Saga. Do both.

### Homebrew

The macOS package manager, if you don't already have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the on-screen instructions at the end — it prints two `eval` commands you
need to run to put `brew` on your `PATH`.

### GitHub CLI

```bash
brew install gh
gh auth login          # github.com → HTTPS → authorise in browser
gh auth setup-git
```

Then add the Projects scope, which is **not** granted by default and which you
will need for org boards:

```bash
gh auth refresh -s read:project
```

Verify:

```bash
gh auth status
```

---

## Step 5 — Get a repo on your machine

Pick whichever repo you work in most. Using `saga-soa` as the example:

```bash
mkdir -p ~/dev && cd ~/dev
gh repo clone saga-ed/saga-soa
cd saga-soa
```

Then start Claude in it:

```bash
claude
```

Claude reads the repo's `CLAUDE.md` files automatically and picks up Saga
conventions. Check that it worked:

> "What is this repo for, and what are the main gotchas?"

If it answers with specifics — pnpm not npm, `pnpm check-types` not `typecheck` —
the context loaded correctly.

---

## Step 6 — The Chrome extension

The single highest-value add-on for PM work. Install the
[Claude in Chrome extension](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn),
then start Claude with:

```bash
claude --chrome
```

Inside a session, `/chrome` shows status and lets you enable it by default.

Full detail, including what it can't do and the safety caveats, is in
[04 — MCP Servers](04-mcp-servers.md#claude-in-chrome).

---

## Step 7 — Skills and plugins

Saga ships a plugin marketplace. `saga-soa` registers it automatically, so in this
repo the skills are already available. Elsewhere you may need to add it yourself.

See [03 — Skills & Plugins](03-skills-and-plugins.md) — do this next, it's where
most of the day-to-day value lives.

---

## Terminal survival kit

The handful of commands worth knowing. You will not need many more, because
Claude runs the rest for you.

| Command | What it does |
|---|---|
| `cd ~/dev/saga-soa` | Go to a folder (`~` is your home folder) |
| `ls` | List what's in the current folder |
| `pwd` | "Where am I?" |
| `claude` | Start a session in the current folder |
| `Ctrl-C` | Stop whatever is running |
| `Cmd-K` | Clear the screen |
| ↑ | Recall the previous command |

Two habits that prevent most confusion:

1. **Claude works in the folder you started it from.** If it can't find your
   files, you're probably in the wrong folder — check with `pwd`.
2. **Open a new terminal tab** (`Cmd-T`) rather than killing a session you might
   want back.

Anthropic also publishes a [terminal guide](https://code.claude.com/docs/en/terminal-guide)
if you want more grounding.

---

## In-session commands worth knowing on day one

| Command | What it does |
|---|---|
| `/help` | Everything available |
| `/clear` | Start fresh — use this between tasks |
| `/compact` | Compress the conversation, keep the thread |
| `/mcp` | Which external services are connected |
| `/plugin` | Install and manage plugins |
| `/permissions` | What Claude may do without asking |
| `/config` | Settings, without editing JSON |
| `/resume` | Reopen an earlier session |
| `/chrome` | Browser integration status |

You can also **paste an image** straight into the prompt — a screenshot of a bug,
a Figma comp, a spreadsheet. This works far better than describing it.

---

## Checkpoint

- [ ] `claude --version` prints a version
- [ ] `claude doctor` reports no errors
- [ ] You're logged in via browser, not an API key
- [ ] `gh auth status` shows you authenticated, with `read:project`
- [ ] A repo is cloned and `claude` in it answers a question about the project
- [ ] The Chrome extension is installed

---

**Next**: [03 — Skills & Plugins](03-skills-and-plugins.md)
