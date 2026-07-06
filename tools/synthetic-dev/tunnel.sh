#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# tunnel.sh — expose the local synthetic-dev stack via the vms rendezvous box.
#
# Reverse-tunnels the browser-facing services to https://<svc>.<moniker>.vms.wootdev.com
# (frp → the EC2 box provisioned by vms/template.yaml — see vms/README.md), so
# other people (coworkers, QA, a second browser profile) can reach YOUR running
# stack. The services keep running locally under `pnpm dev` with HMR — this is
# a front door, not a deploy.
#
# Your moniker (the per-dev namespace label, standard = your initials) lives in
# .vms-moniker alongside this script — gitignored, prompted for on first use,
# and deliberately NEVER taken on the command line (placeholder monikers in
# shared commands cross-contaminate stacks). First use also registers it in the
# SSM moniker registry, which makes the box mint your wildcard cert
# (*.<moniker>.vms.wootdev.com) within ~1 minute.
#
# Usage:
#   ./tunnel.sh [up]        start tunnels (bootstraps moniker on first run)
#   ./tunnel.sh down        stop tunnels
#   ./tunnel.sh status      tunnel process + per-URL health probes
#   ./tunnel.sh moniker     print the moniker (bootstrapping if absent) — used
#                           by up.sh --tunnel; prompts go to stderr so the
#                           value is safely $()-capturable
#   ./tunnel.sh urls        print the public URL table
#
# Normally you don't run this directly: `./up.sh --reset --tunnel` launches the
# services with tunnel-aware env (cookie domain, CORS, VITE_* URLs) AND brings
# these tunnels up. Bare tunnel.sh is for re-attaching tunnels to an already
# tunnel-launched stack (e.g. after a laptop sleep or an frp drop).
#
# Needs: AWS creds for the dev account (SSO; reads /vms/frp-token + registers
# in /vms/monikers). Respects AWS_PROFILE. The frpc binary is auto-downloaded
# (pinned FRP_VERSION, kept under ~/.local/share/synthetic-dev).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE=/tmp/sds-synthetic; mkdir -p "$STATE"
MONIKER_FILE="$SCRIPT_DIR/.vms-moniker"

VMS_BASE="${VMS_BASE:-vms.wootdev.com}"        # rendezvous domain (vms/template.yaml DomainName)
FRP_PORT=7000                                  # frps control port on the box
FRP_VERSION=0.61.1                             # pinned in lockstep with vms/template.yaml FrpVersion
FRP_DIR="$HOME/.local/share/synthetic-dev/frp-$FRP_VERSION"
AWS_REGION=us-west-2
TOKEN_PARAM=/vms/frp-token
MONIKERS_PARAM=/vms/monikers
VMS_AWS_ACCOUNT="${VMS_AWS_ACCOUNT:-396913734878}"  # dev — guard asserts before any SSM write

# Browser-facing services → local ports. Mirrors up.sh's launch table (the
# internal plane — postgres/redis/rabbitmq/mongo — is deliberately absent: it
# gets no tunnel, so it stays unreachable by construction). The hostname label
# is the table key: <label>.<moniker>.$VMS_BASE.
SERVICES=(
    "iam:3010"
    "sis:3100"
    "programs:3006"
    "scheduling:3008"
    "sessions:3007"
    "content:3009"
    "ads-adm:5005"
    "dash:8900"
    "connect:6210"
    "connect-api:6106"
    "rtsm:6110"
    "coach:8800"
    "coach-api:6105"
)

say(){  printf "\033[34m→\033[0m %s\n" "$*" >&2; }
ok(){   printf "\033[32m✓\033[0m %s\n" "$*" >&2; }
warn(){ printf "\033[33m⚠\033[0m %s\n" "$*" >&2; }
err(){  printf "\033[31m✗\033[0m %s\n" "$*" >&2; }

aws_cli(){ aws --region "$AWS_REGION" ${AWS_PROFILE:+--profile "$AWS_PROFILE"} "$@"; }

# All /vms/* state lives in the DEV account, but profile NAMES vary per dev —
# so resolve the profile by ACCOUNT NUMBER: scan ~/.aws/config for a profile
# declaring sso_account_id == $VMS_AWS_ACCOUNT (pure local config reads, no
# network, no token needed). An explicit AWS_PROFILE env always wins. With no
# declared match we fall back to the bare default chain — which is exactly how
# this script once registered a moniker into PROD, hence assert_dev_account
# below verifies whatever was picked before any read or (worse) write.
resolve_aws_profile(){
    [[ -n "${AWS_PROFILE:-}" ]] && return 0
    local p
    while IFS= read -r p; do
        [[ -z "$p" ]] && continue
        if [[ "$(aws configure get sso_account_id --profile "$p" 2>/dev/null)" == "$VMS_AWS_ACCOUNT" ]]; then
            AWS_PROFILE="$p"   # first declared match wins (config order)
            say "AWS profile: '$p' (declares sso_account_id $VMS_AWS_ACCOUNT)"
            return 0
        fi
    done < <(aws configure list-profiles 2>/dev/null)
    AWS_PROFILE=""
}
resolve_aws_profile

# Fail loudly if the credential chain lands in the wrong account (prod SSO,
# stale default profile…) BEFORE any read or — worse — write happens.
assert_dev_account(){
    local acct label="${AWS_PROFILE:-<default chain>}"
    acct=$(aws_cli sts get-caller-identity --query Account --output text 2>/dev/null) \
        || { err "no AWS creds via '$label' — aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}"; return 1; }
    [[ "$acct" == "$VMS_AWS_ACCOUNT" ]] \
        || { err "'$label' resolves to account $acct, expected dev ($VMS_AWS_ACCOUNT) — set AWS_PROFILE, or add an SSO profile for that account (aws configure sso)"; return 1; }
}

# ── moniker: read .vms-moniker, or first-run setup (prompt + SSM register) ──
moniker(){
    if [[ -f "$MONIKER_FILE" ]]; then
        printf '%s\n' "$(tr -d '[:space:]' <"$MONIKER_FILE")"
        return 0
    fi
    [[ -t 0 ]] || { err "no $MONIKER_FILE and no TTY to prompt — create it: echo <moniker> > $MONIKER_FILE"; return 1; }
    assert_dev_account || return 1
    say "first tunnel run — picking your dev moniker (the namespace in"
    say "https://<service>.<moniker>.$VMS_BASE; standard is your initials)"
    local m
    while :; do
        printf "moniker [a-z0-9, 1-8 chars]: " >&2; read -r m
        [[ "$m" =~ ^[a-z0-9]{1,8}$ ]] && break
        warn "'$m' — lowercase letters/digits only, 1-8 chars (it's a DNS label)"
    done
    register_moniker "$m" || return 1
    printf '%s\n' "$m" >"$MONIKER_FILE"
    ok "moniker '$m' saved to $MONIKER_FILE (gitignored) + registered"
    say "the vms box polls the registry every minute and then mints your"
    say "wildcard cert — first ./tunnel.sh up may wait ~2 min for TLS"
    printf '%s\n' "$m"
}

# Append to the SSM StringList registry (create if absent). The box's renderer
# polls this and adds a Caddy site block + wildcard cert for the new moniker.
register_moniker(){ # m
    local m=$1 cur
    cur=$(aws_cli ssm get-parameter --name "$MONIKERS_PARAM" \
              --query Parameter.Value --output text 2>/dev/null) || cur=""
    if [[ -z "$cur" ]]; then
        aws_cli ssm put-parameter --name "$MONIKERS_PARAM" --type StringList \
            --value "$m" >/dev/null || { err "could not create $MONIKERS_PARAM (AWS creds? aws sso login)"; return 1; }
    elif [[ ",$cur," == *",$m,"* ]]; then
        : # already registered
    else
        aws_cli ssm put-parameter --name "$MONIKERS_PARAM" --type StringList \
            --overwrite --value "$cur,$m" >/dev/null || { err "could not update $MONIKERS_PARAM"; return 1; }
    fi
}

# ── frpc binary (pinned, auto-downloaded — same pattern as proxy-dev's mprocs) ──
ensure_frpc(){
    [[ -x "$FRP_DIR/frpc" ]] && return 0
    local arch
    case "$(uname -m)" in
        x86_64)        arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) err "unsupported arch $(uname -m)"; return 1 ;;
    esac
    say "downloading frpc v$FRP_VERSION ($arch) → $FRP_DIR…"
    mkdir -p "$FRP_DIR"
    local tmp; tmp=$(mktemp -d)
    curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz" \
        | tar xz -C "$tmp"
    install -m 0755 "$tmp/frp_${FRP_VERSION}_linux_${arch}/frpc" "$FRP_DIR/frpc"
    rm -rf "$tmp"
    ok "frpc installed"
}

render_frpc_toml(){ # m token → writes $STATE/frpc.toml
    local m=$1 token=$2 entry name port
    {
        printf '# rendered by tunnel.sh — do not edit\n'
        printf 'serverAddr = "%s"\nserverPort = %s\n' "$VMS_BASE" "$FRP_PORT"
        printf 'auth.method = "token"\nauth.token = "%s"\n' "$token"
        printf 'transport.tls.enable = true\n'
        for entry in "${SERVICES[@]}"; do
            name=${entry%:*}; port=${entry#*:}
            printf '\n[[proxies]]\nname = "%s-%s"\ntype = "http"\nlocalPort = %s\ncustomDomains = ["%s.%s.%s"]\n' \
                "$name" "$m" "$port" "$name" "$m" "$VMS_BASE"
        done
    } >"$STATE/frpc.toml"
    chmod 0600 "$STATE/frpc.toml"
}

print_urls(){ # m
    local m=$1 entry name port
    printf "  public URLs (→ local ports):\n" >&2
    for entry in "${SERVICES[@]}"; do
        name=${entry%:*}; port=${entry#*:}
        printf "    %-12s https://%s.%s.%s  → :%s\n" "$name" "$name" "$m" "$VMS_BASE" "$port" >&2
    done
}

tunnel_up(){
    local m token
    m=$(moniker) || exit 1
    assert_dev_account || exit 1
    register_moniker "$m"      # idempotent — heals a hand-written .vms-moniker
    ensure_frpc || exit 1
    say "fetching frp token ($TOKEN_PARAM)…"
    token=$(aws_cli ssm get-parameter --name "$TOKEN_PARAM" --with-decryption \
                --query Parameter.Value --output text 2>/dev/null) \
        || { err "cannot read $TOKEN_PARAM — AWS creds expired (aws sso login), or the vms box isn't provisioned (see vms/README.md)"; exit 1; }
    render_frpc_toml "$m" "$token"
    if [[ -f "$STATE/frpc.pid" ]] && kill -0 "$(cat "$STATE/frpc.pid")" 2>/dev/null; then
        say "frpc already running — restarting with current config…"
        kill "$(cat "$STATE/frpc.pid")" 2>/dev/null || true; sleep 1
    fi
    say "starting frpc (log: $STATE/frpc.log)…"
    ( nohup "$FRP_DIR/frpc" -c "$STATE/frpc.toml" >"$STATE/frpc.log" 2>&1 & echo $! >"$STATE/frpc.pid" )
    local i
    for i in $(seq 1 15); do
        grep -q 'login to server success' "$STATE/frpc.log" 2>/dev/null && break
        kill -0 "$(cat "$STATE/frpc.pid")" 2>/dev/null || { err "frpc died — tail $STATE/frpc.log"; exit 1; }
        sleep 1
    done
    grep -q 'login to server success' "$STATE/frpc.log" 2>/dev/null \
        || { err "frpc didn't reach $VMS_BASE:$FRP_PORT in 15s — tail $STATE/frpc.log (token? box up? — see vms/README.md)"; exit 1; }
    ok "tunnels up as '$m'"
    # End-to-end probe through DNS + Caddy + frp. A fresh moniker needs the
    # box's 1-min registry poll + the ACME DNS-01 mint, hence the long patience.
    say "probing https://iam.$m.$VMS_BASE/health (first run waits on cert mint, ~2 min)…"
    for i in $(seq 1 24); do
        [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://iam.$m.$VMS_BASE/health" 2>/dev/null)" == 200 ]] \
            && { ok "end-to-end OK"; print_urls "$m"; return 0; }
        sleep 5
    done
    warn "no 200 from iam through the tunnel yet. If the local stack is up"
    warn "(./up.sh --status), give the cert mint another minute and check"
    warn "./tunnel.sh status. Otherwise launch with: ./up.sh --reset --tunnel"
    print_urls "$m"
}

tunnel_down(){
    if [[ -f "$STATE/frpc.pid" ]]; then
        kill "$(cat "$STATE/frpc.pid")" 2>/dev/null || true
        rm -f "$STATE/frpc.pid"
    fi
    pkill -f "frpc -c $STATE/frpc.toml" 2>/dev/null || true
    ok "tunnels down"
}

tunnel_status(){
    local m entry name port code
    m=$(moniker) || exit 1
    if [[ -f "$STATE/frpc.pid" ]] && kill -0 "$(cat "$STATE/frpc.pid")" 2>/dev/null; then
        ok "frpc running (pid $(cat "$STATE/frpc.pid"))"
    else
        err "frpc not running — ./tunnel.sh up"
    fi
    for entry in "${SERVICES[@]}"; do
        name=${entry%:*}; port=${entry#*:}
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
            "https://$name.$m.$VMS_BASE$( [[ "$name" == dash || "$name" == connect || "$name" == coach ]] && echo / || { [[ "$name" == connect-api ]] && echo /connectv3/v1/health || echo /health; })" 2>/dev/null)
        printf "  %-12s https://%s.%s.%s → %s\n" "$name" "$name" "$m" "$VMS_BASE" "$code" >&2
    done
}

case "${1:-up}" in
    up)       tunnel_up ;;
    down)     tunnel_down ;;
    status)   tunnel_status ;;
    moniker)  moniker ;;
    # The dev-account profile resolved by account number — for sibling tooling
    # (up.sh fetches the fleek LiveKit creds with it). Empty = default chain.
    aws-profile) printf '%s\n' "$AWS_PROFILE" ;;
    urls)     m=$(moniker) || exit 1; print_urls "$m" ;;
    -h|--help) sed -n '/^# Usage:/,/^# ─────/p' "$0"; exit 0 ;;
    *) echo "unknown: $1 (up|down|status|moniker|urls)"; exit 1 ;;
esac
