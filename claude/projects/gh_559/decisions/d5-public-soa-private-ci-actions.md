# d5 — soa is public and ci-actions is private: how does Vishnu get a CI path?

**RESOLVED 2026-11-02: Option A** (skelly). A standalone workflow in soa using only public actions. soa and ci-actions keep their visibility.

## Context

The plan assumed a thin caller of `saga-ed/ci-actions` `deploy-ecs-api.yml`. Review found that can't work: soa is public, ci-actions is private with `access_level: organization`, and GitHub shares a private repo's workflows only with private repos in the org. Every working caller checked is private, and soa has never used ci-actions.

Visibility and access were read directly on 2026-11-02. The failure itself is predicted from GitHub's documented rules, as no dispatch has run.

Committed so far on `gh_559-Vishnu-CI-deploy`: the `id=codeartifact` Dockerfile, template parameters, ECR URI and mutability, the deploy role, the caller workflow, and the runbook. Only the workflow's two `saga-ed/ci-actions` references depend on this decision, though its input list and parts of the role and runbook would change with it.

## Options

**A. Standalone workflow in soa, using only public actions.** Replace the two ci-actions references with direct steps on `ubuntu-24.04-arm`: typecheck and test, build and push with `docker/build-push-action`, `sam deploy`, a read of the live colour with `aws elbv2`, and a health check.
- Cost: about 100-150 lines to own, which won't pick up fleet pipeline improvements.
- Limit: departs from the fleet pattern, and has no deployment ledger or Slack notices unless added. Vishnu's flow doesn't need switchboard on a colour deploy.

**B. Make ci-actions public.** The workflow as written then works, and any other public repo could use it.
- Cost: an audit of the repo and its history for anything sensitive, plus an org-level decision. Not checked here.
- Limit: exposes internal pipeline details, and timing depends on that audit and its owner.

**C. Make soa private.** The workflow as written then works.
- Cost: unknown, because why soa is public wasn't established. Anything relying on anonymous access would break.
- Limit: code already public stays exposed in any existing copies.

Vendoring ci-actions into soa was also considered. It means owning a 3,000+ line pipeline and its composites, which is worse than A for the same independence.

## Recommendation

**A.** It's the only option entirely within this project's control, and it doesn't depend on an org-level call. It stays simple because Vishnu is one service using dispatch-only colour deploys. If soa or ci-actions changes visibility later, swapping back to the thin caller is a small edit.

## Related artifacts

- I#560
- `research/01-ci-contract-gap.md`, "Blocker found in review"
- `.github/workflows/deploy-vishnu-api.yml`
