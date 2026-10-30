# 06 — Operations

| Task | How |
|---|---|
| Deploy or update a colour | [`infra/vishnu-api/OPS.md`](../../../../infra/vishnu-api/OPS.md); render with `infra/vishnu-api/render-deploy-command.py`, create the change set with `--no-execute-changeset`, review, then execute. |
| Flip live dev traffic | Direct `aws elbv2 modify-rule` on dev rule 4015, changing weights only. **Not** `saga-bluegreen flip`, which is prod-only. |
| View blue in a browser | Header extension (ModHeader) with `x-saga-preview-vishnu-api: blue`, scoped to `vishnu.wootops.org`. |
| Broker binding audit (d5) | [`../../gh_536/scripts/broker-binding-audit.py`](../../gh_536/scripts/broker-binding-audit.py) through `ss env connect rabbitmq --jump-host dev-db-jump-host`. Credential `shared-dev-mq-readonly`, held in memory only. |
| Vishnu DB access | `ss env connect iam --host vishnu.dbs-v2.local --remote-port 5438 --database vishnu --jump-host dev-db-jump-host`. Use the main-branch `ss`; the older installed build can't route through the jump host. |
| Sandbox (patch-party) | Manifest [`../../gh_536/patch-party.json`](../../gh_536/patch-party.json). Direct `sandbox-deploy.yml` dispatches with `event-stats=true`. Identity probe: `/health` with `x-saga-preview-<svc>: sandbox-gh537`. **Teardown is explicit** (patch-party §6). |
| Local synthetic | `ss stack up --set gh536 --only iam-api,programs-api,scheduling-api,vishnu` (slot 3); viewer on :11930. |
| Prerequisites | `/saga-fleet:doctor`; `aws sso login`; `bash scripts/co-login.sh` for CodeArtifact. |

Evidence records: [Gate D](../../gh_538/docs/gate-d-mq-receiver-2026-10-28.md),
[sandbox soak](../../gh_538/docs/sandbox-soak-gh537-2026-10-29.md).
