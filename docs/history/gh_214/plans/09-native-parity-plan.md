# saga-stack-cli — Native-Parity Plan (soa#214, tracker #221)

Reimplement all remaining synthetic-dev functionality natively in TS. Bash stays as `--legacy`/reference, never deleted. Baseline: the daily-driver lifecycle (up/down/status/verify-health/reset/seed/snapshot + prep/provision/migrate engine + the native-default flips) is already native. This plan sequences the mapped remainders.

Guiding order = **value × (1/effort) × dependency**, with a bias toward the correctness gaps that the native-default flips just made load-bearing.

---

## 1. Milestones

### M9 — Native-default hardening (no new heavy seams) — **do first**
Everything that (a) the flips made load-bearing, (b) reuses existing seams or needs only a tiny one, and (c) has no git/gh source-posture or cloud surface. Highest value-per-effort; ships correct behavior for the already-flipped default path.

| Area | Effort | Verdict | Runtime seams | Key risk |
|---|---|---|---|---|
| **auto-pull** (`pull_repos auto`, up.sh 959-990) | M | **Must-have** | New light `git` ff-only runner (status --porcelain, branch --show-current, symbolic-ref origin/HEAD, fetch, rev-list --count, merge --ff-only), injectable; reuse `repos.ts` REPO_ENV_VAR + `resolveRepoRoot`. Pure skip/ff decision in core. | Default-branch detection (origin/HEAD, fallback main) is load-bearing — a wrong test fast-forwards `local/integration` toward main behind the user's back. Fetch is network IO — must stay warn-and-continue. |
| **verify --full DATA checks** (D1–D5, verify.sh 81-122) | S–M | **Must-have** | D4 already free (`PgProbe.hasMigrationsTable('sis_db')`); D5 already free (`MeshExec.ready(connect-mongo, readinessCmd)`); D1/D2/D3 need ONE new `PgProbe.scalar(container, db, sql)` + a pure assertions module. | Keep `users==205` a NOTE, never an assertion (journey/partial profiles vary). Connecting as `postgres_admin` vs verify.sh's `-U iam` reads the same rows — document the divergence. |
| **restart** (`up.sh restart`, 2293-2306) | S | **Must-have** | Compose existing native `down` (launcher.stopServices) → new `vite-clear` fs seam (rm -rf a manifest-derived `.vite` path list) → native `up`. Facade `StackApi.restart` or command-level. | Vite cache paths must match up.sh **exactly** or the stale-bundle trap returns. `reset_data` must NOT fire (restart = no data wipe). Decide the host-global-reap divergence (native dir-scoped teardown is strictly safer; skip up.sh's `pkill -f tsup`/`fuser -k`). |
| **Connect AV** (`connect_av_up`, up.sh 599-607 / gap 1) | S–M | **Nice-to-have** | `docker compose -f <QBOARD>/docker-compose.yml up -d livekit coturn` via existing exec.ts Runner or mesh.ts execFile. Gate on connect-api/connect-web ∈ closure (native improvement over up.sh's unconditional call). Replace the placeholder warn at up.ts:420. | Start AV **only at slot 0** (single-node :7880 bypasses slot offset — split-brain per derive-instance.ts). Best-effort/warn-only; missing compose or name drift ⇒ ⚠, never abort. No health poll, no teardown (parity with up.sh). |
| **apply_fixes residual** (gap 2b) | S | **Mostly done / leave-wrapped** | None new. Confirm `SECURITY_RATELIMITMAXREQUESTS=1000000` + `JWT_ACCESSTOKENTTLSECONDS=28800` in iam-api `launch.env` (services.ts); add if missing. | The env-injection design (launch.env + migrate env + seed env) already supersedes the `.env.local`/`iam-api/.env` dotfile writes — do NOT re-port those. Tracked `config.json` sis-api→:3100 patch (item 5): leave wrapped (up.sh itself flags it a best-guess working-tree edit). |

Optional preflight rider: **check_layout** (3 `existsSync` dir asserts, S) — nice-to-have hardening, cheap. **check_branches** clone-assert is already partly covered by StackApi.up:508; its branch-posture warns belong with the git seam in M12.

**Why M9 first:** the native-default flips (bare-up/seed/e2e-reset) already shipped, so a bare native `up` today **silently runs stale checkouts** (no sibling sync) and **can't hard-fail on missing seed data under `--full`** without delegating. auto-pull + verify-DATA close real correctness gaps in the path users are already on. restart takes the everyday bounce off bash. None need git/gh/cloud seams.

---

### M10 — Native git/overlay engine (the tool's identity)
Port the git-overlay half of refresh-suite.sh (apply/list/reset). This is the daily-driver overlay identity and the enabling seam investment for M12.

| Area | Effort | Verdict | Runtime seams | Key risk |
|---|---|---|---|---|
| **overlay engine (A)** — apply/list/reset (refresh-suite.sh 125-195, 346-408) | M | **Must-have-for-parity** | New `runtime/git.ts` (fetch, rev-parse --verify, status --porcelain, checkout -B, merge --no-ff --no-edit / merge --abort, branch --show-current / -D, checkout — execFile per-repo cwd, mirrors pg-probe.ts/mesh.ts). New `runtime/gh.ts` (`gh pr view <n> --json headRefName`, run in repo cwd — parity over octokit, preserves gh auth). New pure `parseOverlayTsv` + one fs read of `integration-suite.local.tsv`. **Reuse** repos.ts + core/manifest for repo-path/override-env (no new path seam). Repoint existing `overlay.ts` + `flagMap.overlay` from ScriptPlan → native plan. | **Destructive multi-repo state.** `checkout -B local/integration` and the tracked-changes guard, done slightly wrong, overwrite the working tree across THREE repos at once. Port byte-faithfully: skip overridden repos, `.git`-is-a-file worktree detection (`-e` not `-d`), block only on non-`??` porcelain lines, untracked-files-survive-checkout, `merge --abort` cleanup + per-repo/per-PR accounting, **exit codes 0/1** exactly. `local/integration` is local-only — never add push/upstream tracking. gh must resolve in the correct per-repo cwd. |

**Why after M9:** it's must-have but needs two brand-new seams the CLI has zero of today; M9's wins are cheaper and more urgent. M10 is the single git+gh investment that M12 (bootstrap `--yes`, source-posture) then amortizes.

---

### M11 — Bootstrap orchestrator + login cookie-jar core
Mostly glue on top of already-native pieces; unlocks the currently-rejected `--yes` flag and gives headless-harness login parity.

| Area | Effort | Verdict | Runtime seams | Key risk |
|---|---|---|---|---|
| **bootstrap** (bootstrap.sh, 4-step chain) | M | **Nice-to-have** | ~75% free: step 3 `up --reset --seed` = native; step 4 verify = native (+ M9 DATA checks); step 2 overlay-apply = M10 (or wrapper); step 1 install+co:login = native prep (FLIP 4). **Delta = `ensureReposNative`:** git-clone via existing Runner (stdio inherited for SSH host-key prompt), worktree-safe `.git` marker check (dir OR file), interactive [y/N] / `!-t 0` fail-fast / `--yes` confirm seam (readline + isTTY). resolveRepoRoot already ports repo_path/repo_overridden. | Must not silently auto-clone — preserve TTY semantics exactly; only `--yes` auto-confirms. Test `-e .git` not `-d` or it clones OVER a populated worktree (the exact bug bootstrap.sh guards). Keep the staged fail-before-up ordering (don't let lazy prep-install subsume the explicit clone step and surface failures late). Derive the 7 required repos from manifest (exclude coach/fleek) — don't drift from the bash list. |
| **login cookie-jar core** (curl half of login_user, up.sh 1935-1960) | S | **Nice-to-have** | New HTTP-POST-with-Set-Cookie-capture seam (prober only does GET/ok) + Netscape cookie-jar serializer (iam_session/iam_refresh at state dir) + slot-aware iam URL resolver with `LOGIN_IAM_URL` tunnel override. | devLogin is dev-only (403 when AUTH_ENABLED) and **origin-checked** — must send `Origin: <iamUrl>` (iam's own origin) exactly. Default `dev@saga.org` persona 401s before a roster seed — keep login-after-seed ordering + persona error hints. |

Login's **browser half stays delegated** (see §2).

---

### M12 (elective) — verify --full source-posture (P1–P4)
Unlocked by M10's git+gh seam + tsv parser. **Leave-wrapped by default;** port only if native drift-detection earns its keep.

| Area | Effort | Verdict | Runtime seams | Key risk |
|---|---|---|---|---|
| **source-posture** P1 branch, P2 pin-merged, P3 unpinned-overlay, P4 freshness (verify.sh 138-288) | L | **Leave-wrapped / elective** | Extend M10 `GitProbe` (revListCount, diffQuiet, mergeBaseIsAncestor, logMergeSubjects) + `GhProbe` (prHeadRefOid, prHeadRefName, prNumberForHead) + reuse the tsv overlay parser + native default checkout-dir resolution (repos.ts only emits pins today). | **All WARN-only** — never touches exit code (only missing `.git` badlines). A native port risks accidentally hardening drift into a failure. gh auth/network (P2/P3) and git fetch (P4) must fold to warn, never throw. The unpinned-overlay set-subtraction (sed-equivalent branch extraction minus pinned branches) is the gnarliest logic. |

Recommendation: keep delegating P1–P4 to verify.sh under `--full` even after M9 makes D1–D5 native (drop the `VERIFY_HEALTH_ONLY=1` delegation for the DATA half, keep it for posture). Promote to a real milestone only if a second consumer justifies the git+gh seam beyond overlay — which M10 already provides, so the marginal cost here is just the pure posture logic. Treat as opportunistic.

---

## 2. What stays wrapped / leave-as-legacy (explicit decisions)

These are decided non-ports, not omissions:

1. **`stack tunnel` (tunnel.sh) — LEAVE-WRAPPED (strongest candidate). [XL]**
   Value is almost entirely external-system orchestration (AWS SSM params, an EC2 frps rendezvous box, GitHub frpc binary download, DNS/ACME wildcard cert mint) — not logic the CLI benefits from owning. A native port would force the CLI to grow an **AWS dependency it needs nowhere else**, plus port the `assert_dev_account` prod-write guard verbatim (it exists because the script once registered a moniker into PROD). It can't be exercised in CI/offline. **Foreground constraint applies:** first-run moniker bootstrap hard-fails without a TTY — it must never be scheduled into a background agent. The current wrapper is already correct (stdio inherited, moniker never a flag, prompt on TTY, byte-compatible stdout for the `moniker`/`aws-profile` verbs up.sh captures via `$()`). The only must-have-for-parity slice — manifest-driven frpc.toml + URL table — **is already done** (tunnelSlug + lane.tunnel land natively and are unit-tested). Everything else is nice-to-have at best.

2. **`overlay compose-rest` (refresh-suite.sh 197-326) — LEAVE-WRAPPED. [L]**
   A rarely-used cloud sandbox orchestrator bolted onto the overlay script — NOT git. Native reimplementation carries real cloud/credential blast radius the git engine does not: AWS Secrets Manager, a CI bearer secret, the ALB-OIDC bypass header, a 20-minute poll, and it **creates real, billable, TTL'd sandboxes**. The M2 wrapper preserves the exit-2 "composed nothing" semantics and the BASE/SANDBOX_* env-not-argv contract. Wrapping is low-risk and cheap; porting is L for near-zero parity value.

3. **login browser half (`open_login_browser` / browser-login.mjs) — LEAVE-DELEGATED.**
   Session cookies are HttpOnly, so a native process **cannot** inject them into a real browser — the two-half (headless jar + Playwright headful) design is intrinsic, not incidental. It needs a headful Chromium via a persistent single-locked profile, nohup'd to outlive the process, pidfile-tracked, log-polled for AUTOLOGIN_OK/FAIL. `StackApi.login` is already explicitly delegated (stack-api.ts:29,741). Keep delegating until/unless a general background-headful-spawn+pidfile seam exists; the cookie-jar core (M11) covers headless-harness parity in the meantime.

4. **apply_fixes dotfile writes (`.env.local`, `iam-api/.env`) — SUPERSEDED, do not port.**
   Native deliberately injects the same values into each service's `launch.env`, the prisma migrate child env, and the seed env instead of mutating repo working trees — cleaner and slot-offset-correct. The only residual is the tracked `saga-dash config.json` sis-api→:3100 patch, which up.sh itself flags as a best-guess working-tree edit — leave wrapped/skip.

---

## 3. Definition of done for full native parity

Native parity is complete when a developer never needs `--legacy` for any daily-driver or standard-integration workflow:

- [ ] **Bare native `up` syncs siblings** (auto-pull `all`/`auto` modes + `NO_AUTO_PULL` opt-out), reproducing every up.sh skip state (not-cloned, dirty-tracked-only, detached, not-on-default-branch, no-upstream, diverged→warn) with fetch non-fatal. *(M9)*
- [ ] **Bare native `up` starts Connect AV** (livekit+coturn, slot-0-only, best-effort/warn) when connect is in the closure; up.ts:455 warn removed/updated. *(M9)*
- [ ] **`stack verify --full` runs D1–D5 natively** and hard-fails on unseeded/unmigrated/mongo-unreachable, with `users==205` as a NOTE. `VERIFY_HEALTH_ONLY` delegation dropped for the DATA half. *(M9)*
- [ ] **`stack restart` is native** (down → vite-clear → up, no data wipe, vite paths byte-identical). *(M9)*
- [ ] **iam-api `launch.env`** carries the rate-limit + JWT-TTL knobs (apply_fixes parity confirmed). *(M9)*
- [ ] **`stack overlay apply/list/reset` is native** — git engine with byte-faithful guards, `merge --abort` accounting, exit codes 0/1 preserved, gh PR resolution in correct cwd, `local/integration` never pushed. *(M10)*
- [ ] **`stack bootstrap` is native** (ensureReposNative git-clone + orchestrator) and **`bootstrap --yes` works** instead of throwing FlagNotAvailableError; worktree-safe `.git` test; staged fail-before-up ordering. *(M11)*
- [ ] **`stack login` mints a headless cookie jar natively** (devLogin POST + Netscape jar), origin-checked, login-after-seed ordering; browser half remains delegated by design. *(M11)*
- [ ] **Every native command preserves the exit-code contract** used by CI `&&` chains and gates (overlay 0/1, verify hard-fail, compose-rest's exit-2 via the wrapper).
- [ ] **Explicitly-wrapped set documented and stable:** tunnel, compose-rest, login-browser, apply_fixes dotfiles — each with a written rationale, not a silent gap. *(source-posture P1–P4 wrapped unless M12 elected)*
- [ ] **No native command requires foreground in a background context** (tunnel first-run bootstrap stays TTY-gated and wrapper-only).
- [ ] Bash retained as `--legacy` throughout; nothing deleted.

---

## 4. Recommended next milestone

**Start M9, and within it do auto-pull first.**

- **Why M9:** it's the only milestone that is entirely must-have/high-value **and** needs no new heavy seam (no git-probe-family, no gh, no AWS, no HTTP-with-cookies). Every item reuses an existing seam or a trivial new one (PgProbe.scalar, a vite-clear fs rm, a docker-compose Runner call, a light ff-only git runner). It's the fastest path to making the *already-flipped* native default correct.
- **Why auto-pull specifically:** the native-default flips shipped, so bare native `up` **currently runs stale sibling checkouts silently** — exactly the behind-origin trap up.sh's preflight (2255-2260) exists to prevent. That's a live correctness regression on the path users are already defaulted onto, not a convenience gap. It's mechanically simple (the risk is purely faithfulness of the skip/ff decision, which is pure-core and unit-testable IO-free) and introduces the first small `git` seam that later work builds on.
- **Then** verify-DATA (cheap, D4/D5 nearly free) and restart (S, pure compose) round out M9; AV and the apply_fixes/check_layout riders are the nice-to-have tail. M10 (overlay git engine) is the next must-have after M9 and the seam it lands (`runtime/git.ts` + `runtime/gh.ts`) is what makes M11 bootstrap and the elective M12 source-posture cheap.
