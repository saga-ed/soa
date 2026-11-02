# d1 — Does Vishnu need its own sandbox deploys?

**PENDING RECONFIRMATION.** skelly ruled Option C on 2026-11-02, but this doc then understated its cost and wrongly called gh_536 d9 pending. See Correction.

## Correction (2026-11-02)

d9 was **RESOLVED on 2026-10-29**: skelly chose option (a), an idle colour observes one sandbox. PR#556's body still says PENDING, and this doc repeated that without reading d9.

d9 also considered and did not choose option (b), "Vishnu as a real sandbox member", which is this doc's Option C. Its costed list includes items missing below: **a per-sandbox Vishnu database, a JANUS host for a sandbox Vishnu, and the dispatch allowlist. d9's estimate: "Weeks of work, and none of it is needed to watch three reporters."**

So Option C reverses part of an earlier ruling at a higher cost than stated here. d9 (a) stands either way, and I#560's preview-tag input serves it.

## Context

Other services deploy into a patch party as `sandbox-<name>`, with their own target group and header route. The gh_559 plan first assumed Vishnu needed the same.

PR#556 (design: gh_536 d9, RESOLVED 2026-10-29) does something different: Vishnu stays in dev, and one idle colour is redeployed with `EventStatsPreviewTag=sandbox-<name>` so that it observes one sandbox's telemetry. For that, the "sandbox deploy" is a normal colour deploy with one extra parameter, which the I#560 workflow can carry.

## Options

**A. Colour deploys only; close I#561.** The I#560 workflow covers sandbox observation, and the idle colour doubles as a header-gated preview for testing Vishnu's own changes.
- Cost: nothing further.
- Limit: two colours, so one observed sandbox and one preview at a time, and the two uses share the idle colour.

**B. Defer I#561; decide when something needs it.** The same work today, but the issue stays open with its research attached.
- Cost: nothing now.
- Limit: an open issue that may never be picked up.

**C. Build per-sandbox and PR previews now.** Vishnu joins patch party like other services, and several sandboxes can each have their own Vishnu.
- Cost: `saga-init.yaml`, a routing template, two to four workflows, a wider deploy role, opening `Identifier`, and answering the switchboard catalog and preview-header questions.
- Limit: Vishnu is a staff-only viewer with one consumer of this capability today.

## Recommendation

**B.** No current need requires C, and the concrete need (PR#556) is met by I#560. Keeping I#561 open preserves the research if someone wants Vishnu in a patch party. Choose A if you'd rather not keep the issue around.

The recommendation stands, more strongly now that d9 has been read.

## Related artifacts

- I#560, I#561, PR#556
- `claude/projects/gh_536/decisions/d9-vishnu-sandbox-observation.md` on branch `gh_538-vishnu-sandbox`
- `research/01-ci-contract-gap.md`, "Sandbox flow"
