# Worktree preparation — 2026-10-22

## Baseline and preservation

The epic starts from fetched SOA main `10924a216c0ab6f2371de8ddb0cbc2f9aca2993a`. The original discovery checkout remains at `516d4e4d` on `work/vishnu-discovery-handoff`, with its tracked and untracked changes untouched.

Verified recovery snapshot: `/home/skelly/.codex/backups/vishnu-step3-20261022T184037Z`. It contains tracked/index binary patches, status, an archive of 59 untracked files and SHA-256 checks. `.Codex/` was excluded because it holds a separate registered worktree; it was left untouched. Ignored build/dependency artifacts are not included. The original branch's committed discovery records remain in Git.

## Refreshed guidance

The earlier preparation read the old discovery checkout. On current main use `.claude/rules/event-driven.md`, `.claude/rules/testing-node.md` and `docs/testing/` instead of their former `claude/` paths. Current root guidance requires explicit version bumps and manual `publish-codeartifact.yml` single-package dispatch; preflight checks published workspace dependencies. The event libraries now include activity gates for inactive blue/green colors; step 4 must re-inspect the current lifecycle boundaries and preserve this behavior.

Node 24.12.0, pnpm 9.15.3 and Docker server 29.9.1 were available at preparation time. Dependency installation and runtime tests are deferred until implementation preparation. Skill references use verified saga-iac 1.22.0 from `/home/skelly/.claude/plugins/cache/saga-tools/saga-iac/1.22.0`.

## Slot ownership and recovery

Set `gh536`, slot 3, points to `/home/skelly/dev/worktrees/soa-gh_535-event-stats`. `ss set check gh536` passed. No stack boot, reset or volume deletion was performed.

Previous set `gh696` was down and last driven 15 days earlier. Only its binding was removed; worktrees and volumes were preserved. Full registry backup: `/home/skelly/.saga-stack/worktree-sets.json.bak-pre-gh536-2026-10-22`. To restore later, copy that backup's `sets.gh696` object into the then-current registry using an available slot, and validate with `ss set check gh696`. Never overwrite the entire live registry with the backup: other sessions are actively changing it.

Preserved paths:
- `/home/skelly/dev/worktrees/sds-gh_696-ADM-preswitch-readonly-history`
- `/home/skelly/dev/worktrees/saga-dash-gh_696-ADM-preswitch-readonly-history`

Slot 6 changed ownership during inspection and was left alone. Slot 0 remains the existing shared Vishnu baseline.
