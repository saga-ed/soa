# d6 — What gates the `dev` GitHub environment?

**PENDING**

## Context

`SoaGithubActionDevDeployRole` trusts only the `environment:dev` subject for saga-ed/soa. With no gate on that environment, anyone with write access could push a branch with their own workflow, bind `environment: dev`, and assume the role, skipping the live-colour guard and tests. Forks and PRs from forks can't do this.

The role is limited to the dev account's Vishnu stacks, the `soa/vishnu-api` repo and Vishnu's task roles. The worst case is replacing dev Vishnu, including the live colour. No prod access is involved.

d4 needs dispatch from non-main branches, so PR#556 can deploy its own branch.

The `dev` environment doesn't exist yet. A human creates it as a one-time step.

## Options

**A. No gate; record that repo write access equals dev Vishnu deploy access.**
- Cost: none, and dispatch stays one click.
- Limit: the guard protects against mistakes, not against a deliberate write-access holder.

**B. Required reviewer on the environment.** Each bound job waits for approval.
- Cost: three approval waits per dispatch unless approved together, and a reviewer must be available. Add "prevent self-review" for it to mean a second person.
- Limit: the most friction, for a dev-only tool.

**C. Branch policy: `main` only.**
- Cost: conflicts with d4, because PR#556 couldn't deploy by dispatch before merging.
- Limit: the soa ruleset requires 0 approvals, so this adds a PR and merge trail but no second person.

## Recommendation

**A.** The role's reach is narrow and dev-only, and people with write access are already trusted with soa. Revisit if the role's scope grows or Vishnu gets a prod path, where B would be right.

## Related artifacts

- `infra/github-oidc/README.md`, "Trust"
- d4, d5, I#560
