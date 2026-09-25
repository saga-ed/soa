# gh_298 — ss Tunnel Mode

Status: CLOSED 2026-07-16
Archived: research/, source/ @ f110606a

Finish-and-verify effort to bring tunnel mode to the `ss` synthetic-dev CLI
at parity with `up.sh --tunnel`, driven by the real use case of inviting
coworkers to test Connect via a publicly-reachable URL against a local
stack. Landed: re-vendored `tunnel.sh` + drift guard, coach browser-plane
overlay, `ss e2e run/connect --tunnel`, and `docs/tunnel.md` +
cross-references. The validation pass refuted the plan's own gap count,
finding a 3rd gap (coach's browser-plane `tunnel_env`), also since closed.

Retrieve the archived content: `git show f110606a:docs/history/gh_298/research/findings.md`
(or `source/plan.md`, `research/validation-report.md`) — or
`git checkout f110606a -- docs/history/gh_298` for the whole subtree.

Parent context: [../../../CLAUDE.md](../../../CLAUDE.md)
