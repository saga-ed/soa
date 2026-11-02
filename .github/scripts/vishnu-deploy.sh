#!/usr/bin/env bash
# Steps of .github/workflows/deploy-vishnu-api.yml, run from the repo root.
# Inputs arrive through the environment and are validated before use. They are never
# eval'd or echoed before validation (a public repo's logs and ::error:: lines are public).
#
#   guard         needs COLOUR, PREVIEW_TAG; refuses a deploy that isn't safe right now
#   image-exists  needs IMAGE_TAG, GITHUB_OUTPUT; sets exists=true|false
#   sam-deploy    needs COLOUR, PREVIEW_TAG, IMAGE_REPOSITORY, BUILD_REVISION
#   health        needs COLOUR, BUILD_REVISION
set -euo pipefail

readonly ALB_NAME=dev-account-alb
readonly HOST=vishnu.wootops.org
readonly LIVE_RULE_PRIORITY=4015
readonly SERVICE_TEMPLATE=infra/shared/service-template.yaml
readonly RENDERER=infra/vishnu-api/render-deploy-command.py
readonly ECR_REPOSITORY_NAME=soa/vishnu-api

# stderr, because fail also runs inside $(...). The runner parses ::error:: on both streams.
fail() {
  echo "::error::$*" >&2
  exit 1
}

validate_inputs() {
  case "${COLOUR:-}" in
    blue | green) ;;
    *) fail "colour must be blue or green" ;;
  esac
  if [ -n "${PREVIEW_TAG:-}" ] && ! [[ "$PREVIEW_TAG" =~ ^sandbox-[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$ ]]; then
    fail "preview-tag must be sandbox-<name>"
  fi
}

validate_revision() {
  [[ "${BUILD_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] || fail "BUILD_REVISION must be a full git sha"
}

# Prints the serving colour. Fails closed if rule 4015 is missing, isn't this host's,
# is split, is weighted all zero, or forwards to anything but the two colour target groups.
read_live_colour() {
  local lb_arn listener_arn rule weights
  lb_arn=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  [[ "$lb_arn" == arn:* ]] || fail "Load balancer $ALB_NAME not found"
  listener_arn=$(aws elbv2 describe-listeners --load-balancer-arn "$lb_arn" \
    --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text)
  [[ "$listener_arn" == arn:* ]] || fail "$ALB_NAME has no 443 listener"
  rule=$(aws elbv2 describe-rules --listener-arn "$listener_arn" \
    --query "Rules[?Priority=='$LIVE_RULE_PRIORITY'] | [0]" --output json)
  [ "$rule" != "null" ] || fail "Live rule $LIVE_RULE_PRIORITY is missing"

  jq -e --arg host "$HOST" \
    '[.Conditions[] | select(.Field == "host-header") | .Values[]] == [$host]' <<<"$rule" >/dev/null \
    || fail "Live rule $LIVE_RULE_PRIORITY is not for $HOST"

  # One "<target group name> <weight>" per line; empty unless there is exactly one forward action.
  weights=$(jq -r '
    [.Actions[] | select(.Type == "forward")] as $forward
    | if ($forward | length) == 1 then $forward[0].ForwardConfig.TargetGroups // [] else [] end
    | .[] | "\(.TargetGroupArn | split(":targetgroup/")[1] | split("/")[0]) \(.Weight)"' <<<"$rule")
  [ -n "$weights" ] || fail "Live rule $LIVE_RULE_PRIORITY has no single forward action"

  local name weight live="" count=0
  while read -r name weight; do
    case "$name" in
      vishnu-api-blue-tg | vishnu-api-green-tg) ;;
      *) fail "Live rule $LIVE_RULE_PRIORITY forwards to an unexpected target group: $name" ;;
    esac
    [[ "$weight" =~ ^[0-9]+$ ]] || fail "Live rule $LIVE_RULE_PRIORITY has an unreadable weight"
    if [ "$weight" != "0" ]; then
      live=${name#vishnu-api-}
      live=${live%-tg}
      count=$((count + 1))
    fi
  done <<<"$weights"
  [ "$count" -ne 0 ] || fail "Live rule $LIVE_RULE_PRIORITY is weighted all zero, so the live colour is unknown"
  [ "$count" -eq 1 ] || fail "Live rule $LIVE_RULE_PRIORITY is split between the colours"
  echo "$live"
}

# SAM drops parameters the template doesn't declare, sends UsePreviousValue for those it
# isn't given, and rejects `Key=`. /health can't see a wrong scope, so stop it here.
check_event_stats_scope() {
  local stack="soa-vishnu-api-$COLOUR" params err scope mq_enabled
  if [ -n "${PREVIEW_TAG:-}" ] && ! grep -Eq '^ +EventStatsPreviewTag:' "$SERVICE_TEMPLATE"; then
    fail "This ref's service template does not declare EventStatsPreviewTag (PR#556), so SAM would drop the tag (infra/vishnu-api/OPS.md)"
  fi
  err=$(mktemp)
  if params=$(aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].[Parameters[?ParameterKey=='EventStatsDeployment'].ParameterValue | [0], Parameters[?ParameterKey=='VishnuMqEnabled'].ParameterValue | [0]]" \
    --output text 2>"$err"); then
    read -r scope mq_enabled <<<"$params"
  elif grep -q "$stack does not exist" "$err"; then
    # A new stack takes the template defaults, which are main scope with MQ off.
    scope=main
    mq_enabled=false
  else
    fail "Could not read $stack: $(cat "$err")"
  fi
  if [ -n "${PREVIEW_TAG:-}" ] && [ "$mq_enabled" != "true" ]; then
    fail "$stack has VishnuMqEnabled=$mq_enabled, and preview-tag needs true (infra/vishnu-api/OPS.md)"
  fi
  if [ -z "${PREVIEW_TAG:-}" ] && [ "$scope" != "main" ] && [ "$scope" != "None" ]; then
    fail "$stack is at EventStatsDeployment=$scope, and an empty preview-tag would keep it. Pass the tag, or return the colour to main scope first (infra/vishnu-api/OPS.md)"
  fi
}

guard() {
  local live
  validate_inputs
  live=$(read_live_colour)
  echo "Live colour: $live"
  if [ "$COLOUR" = "$live" ]; then
    fail "$COLOUR is serving live traffic. Deploy the idle colour and flip."
  fi
  check_event_stats_scope
}

image_exists() {
  local err exists=false
  [[ "${IMAGE_TAG:-}" =~ ^[0-9a-f]{40}$ ]] || fail "IMAGE_TAG must be a full git sha"
  err=$(mktemp)
  if aws ecr describe-images --repository-name "$ECR_REPOSITORY_NAME" \
    --image-ids "imageTag=$IMAGE_TAG" --query 'imageDetails[0].imageDigest' --output text >/dev/null 2>"$err"; then
    exists=true
  elif ! grep -q ImageNotFoundException "$err"; then
    fail "Could not read $ECR_REPOSITORY_NAME: $(cat "$err")"
  fi
  echo "exists=$exists" >>"$GITHUB_OUTPUT"
  echo "Image $IMAGE_TAG exists: $exists"
}

sam_deploy() {
  validate_inputs
  validate_revision
  local stage rendered
  local overrides=("ImageArn=${IMAGE_REPOSITORY:?}:$BUILD_REVISION" "BuildRevision=$BUILD_REVISION")
  if [ "$COLOUR" = green ]; then
    stage=dev-green
    # samconfig holds green at 0. Blue's is already 1, and the renderer refuses it as an override there.
    overrides+=(DesiredCount=1)
  else
    stage=dev
  fi
  if [ -n "${PREVIEW_TAG:-}" ]; then
    # The guard read VishnuMqEnabled=true from the stack; PR#556's renderer also requires it spelled out.
    overrides+=("EventStatsPreviewTag=$PREVIEW_TAG" "EventStatsDeployment=$PREVIEW_TAG" VishnuMqEnabled=true)
  fi
  rendered=$(python3 "$RENDERER" "$stage" "${overrides[@]}")

  # Split the printed command into arguments without a shell, dropping the two flags meant
  # for an operator. The parameter list stays in samconfig.yaml.
  local args=()
  mapfile -d '' -t args < <(python3 -c '
import shlex, sys
lines = [line for line in sys.stdin.read().splitlines() if line and not line.startswith("#")]
if len(lines) != 1:
    sys.exit("expected one rendered command")
argv = shlex.split(lines[0])
if argv[:2] != ["sam", "deploy"]:
    sys.exit("expected sam deploy")
out, tokens = [], iter(argv[2:])
for token in tokens:
    if token == "--profile":
        next(tokens)
    elif token != "--confirm-changeset":
        out.append(token)
sys.stdout.write("".join(token + "\0" for token in out))
' <<<"$rendered")
  [ "${#args[@]}" -gt 0 ] || fail "Could not parse the rendered sam command"

  sam deploy "${args[@]}" --no-confirm-changeset --no-fail-on-empty-changeset
}

# CloudFormation has already waited for the service, so retries only cover the old task
# draining. /health runs before the host and session checks, and reports colour and version.
health() {
  validate_inputs
  validate_revision
  local attempts=${HEALTH_ATTEMPTS:-30} delay=${HEALTH_DELAY_SECONDS:-10} body code="" i
  body=$(mktemp)
  for ((i = 1; i <= attempts; i++)); do
    code=$(curl -sS --max-time 10 -o "$body" -w '%{http_code}' \
      -H "x-saga-preview-vishnu-api: $COLOUR" "https://$HOST/health") || code=000
    if [ "$code" = 200 ] && jq -e --arg colour "$COLOUR" --arg version "$BUILD_REVISION" \
      '.status == "ok" and .colour == $colour and .version == $version' "$body" >/dev/null 2>&1; then
      echo "$COLOUR is healthy at $BUILD_REVISION"
      return 0
    fi
    echo "Attempt $i/$attempts: HTTP $code"
    if [ "$i" -lt "$attempts" ]; then sleep "$delay"; fi
  done
  head -c 500 "$body" || true
  echo
  if [ "$code" = 403 ]; then
    fail "$COLOUR health returned 403. /health has no auth, so suspect the WAF blocked this runner's IP; the stack did deploy (infra/vishnu-api/OPS.md)"
  fi
  fail "$COLOUR did not report healthy at $BUILD_REVISION (last HTTP $code)"
}

case "${1:-}" in
  guard) guard ;;
  image-exists) image_exists ;;
  sam-deploy) sam_deploy ;;
  health) health ;;
  *) fail "usage: vishnu-deploy.sh guard|image-exists|sam-deploy|health" ;;
esac
