# d4 — How does I#560 land relative to PR#556?

**PENDING**

## Context

PR#556 (`gh_538-vishnu-sandbox`) is a draft and currently mergeable. It adds `EventStatsPreviewTag` to `infra/shared/service-template.yaml`, a new section to `infra/vishnu-api/OPS.md`, and renderer changes. I#560 touches the same template and runbook, in different places, and its workflow needs to pass the preview tag to serve gh_536 d9.

Two facts shape this:

- GitHub only offers `workflow_dispatch` for a workflow whose file is on the default branch. Until the workflow is on main, it can't be dispatched against any branch, including PR#556's. *(GitHub behaviour, not tested in this repo.)*
- CloudFormation rejects undeclared parameters, so the workflow can send `EventStatsPreviewTag` only where the template declares it.

## Options

**A. Land I#560 on main first, independently.** The workflow passes the preview tag only when the input is set. Setting it on a ref without PR#556 fails with a clear CloudFormation error. PR#556 then merges main and can be deployed by dispatch against its own branch.
- Cost: a small rebase on whichever lands second.
- Limit: the d9 soak needs PR#556's branch to have merged main first.

**B. Base I#560 on PR#556's branch and land after it.** The tag is available from the start.
- Cost: I#560's diff includes PR#556 until that lands, and the CI path waits on a draft.
- Limit: per the first fact, no dispatch is possible until both are on main, so the soak would still need a manual build.

**C. Fold I#560 into PR#556.** The fewest PRs, matching the preference for Vishnu.
- Cost: mixes a telemetry feature with deploy infrastructure and an IAM role in one review.
- Limit: the CI path can't be used until the whole PR lands, for the same reason as B.

## Recommendation

**A.** It's the only option where CI can deploy PR#556's branch before PR#556 merges, which is what the d9 soak needs. Otherwise the manual, emulated build continues for that soak.

## Related artifacts

- I#560, PR#556
- gh_536 d9 on branch `gh_538-vishnu-sandbox`
- `plans/01-plan-of-record.md`
