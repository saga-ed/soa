# Integration workflows — overlay · bootstrap · login · tunnel

← [Getting started](./getting-started.md)

Beyond the local lifecycle, `ss` drives the cross-repo integration workflows: overlaying your
in-flight PRs, standing the stack up from scratch, logging in a persona, and sharing your
stack over a tunnel.

## `overlay` — test your in-flight PRs together

Overlays PR branches from your personal `integration-suite.local.tsv` (or `--prs` ad-hoc)
onto a clean main-based stack, across rostering / program-hub / saga-dash. All native git.

```bash
ss stack overlay list                          # show your personal overlay file
ss stack overlay apply --prs 165 saga-dash
ss stack overlay reset                         # back out to main
```

<details><summary>apply merges the PR branches onto a fresh <code>local/integration</code>; reset restores main — your overlay file untouched</summary>

```
$ ss stack overlay reset
Personal overlay (…/tools/synthetic-dev/integration-suite.local.tsv):
✓ rostering already on 'main' (not overlaid)
✓ program-hub already on 'main' (not overlaid)
✓ saga-dash already on 'main' (not overlaid)
→ saga-dash — removed stale local/integration branch
✓ backed out — repos on main (your overlay file is untouched)
```

Safe by construction: it refuses to touch a repo with uncommitted tracked changes, never
force-deletes commits, and `local/integration` is never pushed. `overlay compose-rest` (cloud
fleet sandboxes) delegates to a bundled script.
</details>

## `bootstrap` — one command, from nothing to a verified stack

Ensures the sibling repos are cloned/on-main → up → seed → verify. `--yes` for non-interactive.

```bash
ss stack bootstrap --seed full --yes
```

<details><summary>ensure repos → up → seed → verify, in order (aborts before <code>up</code> if a repo can't be ensured)</summary>

```
✓ all 7 required sibling repo(s) present
==> up --reset --seed full …
==> verify --full …
✓ bootstrap complete
```

It never silently clones — a missing repo in a non-interactive session without `--yes` fails
fast rather than cloning unprompted. A linked-worktree checkout counts as present.
</details>

## `login` — a persona session for headless harnesses

Mints a real iam session (dev-only `devLogin`, origin-checked) and writes a Netscape cookie
jar that `curl --cookie` and Playwright `storageState` can read.

```bash
ss stack login                      # default persona → cookie jar
ss stack login teacher@saga.org     # a specific persona
ss stack login --browser            # + open a headful auto-logged-in Chromium
```

<details><summary>✓ session minted → <code>&lt;stateDir&gt;/cookies.txt</code> with iam_session + iam_refresh</summary>

```
✓ session minted — cookie jar → /tmp/sds-synthetic/cookies.txt (headless harnesses: curl --cookie / Playwright storageState)
  cookies: iam_session, iam_refresh
```

The default persona 401s before a roster seed exists — the command surfaces a
"seed first" hint rather than crashing. `--browser` opens the headful flow (a native process
can't inject HttpOnly cookies into a real browser, so that half runs a bundled Playwright helper).
</details>

## `tunnel` — share your local stack

Exposes the browser-facing services via the vms rendezvous
(`https://<svc>.<moniker>.vms.wootdev.com`) for multi-user testing (e.g. a live Connect
session with real remote participants).

```bash
ss stack tunnel up        # start the tunnels (bootstraps your moniker on first run)
ss stack tunnel status    # process + per-URL health
ss stack tunnel urls      # the public URL table
ss stack tunnel down
```

> `tunnel` needs AWS creds for the dev account and prompts for your moniker on first use (it
> runs in the foreground and owns your terminal). It's the one workflow that stays a thin
> wrapper over a bundled script — it orchestrates external AWS/frp infra.

← [e2e](./e2e.md) · [Getting started](./getting-started.md)
