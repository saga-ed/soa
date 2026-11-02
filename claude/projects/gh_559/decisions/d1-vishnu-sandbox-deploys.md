# d1 — Does Vishnu need its own sandbox deploys?

**PENDING**

## Context

Other services deploy into a patch party as `sandbox-<name>`, with their own target group and header route. The gh_559 plan first assumed Vishnu needed the same.

PR#556 (design: gh_536 d9, itself PENDING) does something different: Vishnu stays in dev, and one idle colour is redeployed with `EventStatsPreviewTag=sandbox-<name>` so that it observes one sandbox's telemetry. For that, the "sandbox deploy" is a normal colour deploy with one extra parameter, which the I#560 workflow can carry.

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

If d9 is ruled against colour-based observation, reopen this decision.

## Related artifacts

- I#560, I#561, PR#556
- `claude/projects/gh_536/decisions/d9-vishnu-sandbox-observation.md` on branch `gh_538-vishnu-sandbox`
- `research/01-ci-contract-gap.md`, "Sandbox flow"
