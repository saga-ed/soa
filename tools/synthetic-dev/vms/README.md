# vms — synthetic-dev tunnel rendezvous server

One small EC2 box (t4g.small + EIP, dev account) that makes a developer's
**local** synthetic-dev stack reachable by other people at stable HTTPS names:

```
coworker (anywhere) ──HTTPS──▶  vms.wootdev.com box (EIP)
                                  │ Caddy :443 — per-dev wildcard certs (DNS-01)
                                  │ frps  :8080 vhost — Host-header routing
                                  ▼ reverse tunnel (frp, token-gated :7000)
            connect.jw.vms.wootdev.com      → your laptop :6210
            connect-api.jw.vms.wootdev.com  → your laptop :6106
            rtsm.jw.vms.wootdev.com         → your laptop :6110
            iam.jw.vms.wootdev.com          → your laptop :3010   …etc
```

The hostname scheme is `<service>.<moniker>.vms.wootdev.com` — a short
per-dev moniker (your initials) namespaces every instance, so any number of
devs share this one box with zero per-dev server config. Day-to-day use is
entirely laptop-side: `../tunnel.sh` (or `../up.sh --tunnel`). This directory
is only the **infra**: the CloudFormation template + these ops docs.

**This is a dev/multi-user tool, not a deploy artifact.** The services keep
running on your laptop under `pnpm dev` with HMR; the box only fronts them.

## How it works (the three tricks)

1. **DNS**: one wildcard record `*.vms.wootdev.com → EIP`. DNS wildcards match
   multiple labels, so `connect-api.jw.vms.wootdev.com` already resolves —
   no per-dev or per-service DNS ever.
2. **TLS**: X.509 wildcards match only ONE label, so the box keeps a tiny
   moniker registry (SSM `/vms/monikers`) and renders one Caddy site block —
   and therefore one Let's Encrypt **wildcard cert `*.<moniker>.vms.wootdev.com`**
   — per registered dev, minted via Route53 DNS-01 (instance role is
   zone-scoped). Registering a moniker is something `tunnel.sh` does from the
   laptop (SSM append); the box polls the registry every minute.
3. **Routing**: Caddy terminates TLS and proxies everything (Host preserved)
   to frps's local vhost port; each laptop's `frpc` declares its hostnames via
   `customDomains`, so adding a service/dev never touches the box.

## One-time provisioning

Prereqs: AWS SSO creds in the dev account (396913734878), SAM CLI.

```bash
# 1. Shared frp auth token (CloudFormation can't create SecureStrings).
aws ssm put-parameter --region us-west-2 --profile SagaDevelopmentProfile \
    --name /vms/frp-token --type SecureString \
    --value "$(openssl rand -hex 32)"

# 2. Deploy the stack (EC2 + EIP + SG + role + DNS records + cloud-init).
cd tools/synthetic-dev/vms
sam deploy --config-env vms --profile SagaDevelopmentProfile

# 3. Verify (cert mint for the apex takes ~1 min after boot).
curl -s https://vms.wootdev.com    # → "vms tunnel rendezvous - see ..."
```

That's it. Devs self-register from their laptops on first `tunnel.sh` run.

## What the stack creates

| Resource | Notes |
|---|---|
| EC2 `synthetic-dev-vms` (t4g.small, AL2023 arm64) | fully regenerable from cloud-init; the EIP is the identity |
| EIP + `vms.wootdev.com` / `*.vms.wootdev.com` A records | zone `Z06686211OOAM6WWKX6KW` (wootdev.com) |
| SG: 443/80/7000 open, **no SSH** | shell via SSM: `aws ssm start-session --target $(aws ssm get-parameter --name /vms/infra/dev/instance-id --query Parameter.Value --output text)` |
| Instance role | `AmazonSSMManagedInstanceCore` + Route53 change scoped to the zone (DNS-01) + read `/vms/*` SSM params |
| SSM `/vms/infra/dev/public-ip`, `/vms/infra/dev/instance-id` | written by the stack |

SSM parameters it **reads** (not stack-managed):

| Param | Type | Who writes it |
|---|---|---|
| `/vms/frp-token` | SecureString | you, step 1 above |
| `/vms/monikers` | StringList | `tunnel.sh` (create-or-append on first run per dev) |

## Security posture

- **Public by design.** Anyone can resolve and TCP-connect; what they reach is
  a dev's synthetic-data stack (no PII — the seed is synthetic by
  construction). The known sharp edge: local stacks run iam-api with
  `devLogin` enabled, so anyone with the URL can mint a session as any
  synthetic persona. Acceptable for synthetic data; if it ever isn't, the
  graduated responses are a per-dev secret moniker, or running the local
  iam-api with `JANUS_REQUIRED=true` (the existing JumpCloud gate).
- Tunnel **registration** requires the frp token (SSM SecureString, dev-account
  SSO needed) — outsiders can't attach tunnels.
- The box itself: no SSH port, SSM-only access, nothing listens but Caddy
  (80/443) and frps (7000, token + TLS).
- IAM: route53 writes are zone-scoped; SSM reads are `/vms/*`-scoped.

## Operations

```bash
# Health
curl -s https://vms.wootdev.com
# Logs / shell (no SSH)
aws ssm start-session --target <instance-id> --profile SagaDevelopmentProfile
#   then: journalctl -u caddy -u frps -u vms-render --since -1h
#   cloud-init log: /var/log/vms-init.log
# Force a config re-render (normally the 1-min timer does this)
#   sudo /usr/local/bin/vms-render
# Rotate the frp token (devs' tunnel.sh picks it up on next `up`)
aws ssm put-parameter --name /vms/frp-token --type SecureString --overwrite --value "$(openssl rand -hex 32)"
# Remove a dev: edit /vms/monikers (StringList) — the renderer drops their
# site block within a minute
# Replace the box (AMI refresh / config change): just redeploy the stack —
# the instance is disposable, EIP + DNS + certs(re-minted) survive
sam deploy --config-env vms --profile SagaDevelopmentProfile
# Tear down everything (also releases the EIP — DNS records die with it)
sam delete --stack-name synthetic-dev-vms --region us-west-2 --profile SagaDevelopmentProfile
```

## Costs

~$12/mo (t4g.small) + ~$3.6/mo EIP + single-digit GB egress. Pennies/day; if
it falls out of use, `sam delete` and re-provision later in ~5 minutes.

## Known limitations

- **AV (LiveKit) does not traverse the tunnels** (WebRTC media is UDP), so
  `up.sh --tunnel` repoints connect-api at the **real fleek dev cluster**
  (`wss://*.fleek.wootdev.com` + creds auto-fetched from Secrets Manager
  `qboard/fleek/livekit-creds`). Falls back to CRDT-only for guests if the
  creds fetch fails. CRDT/whiteboard/chat always work (rtsm is websockets —
  tunnels fine).
- **saga-dash for REMOTE users** needs saga-dash PR #194 (the `url` service
  override type) — pin it in `integration-suite.local.tsv` until it lands.
  With it, `up.sh --tunnel` rewrites the dash's `config.json` `localDefaults`
  to url-type entries pointing at the tunnel hosts (and restores the
  localhost shape on the next non-tunnel run).
- frps/frpc versions are pinned in lockstep (`FrpVersion` here,
  `FRP_VERSION` in `tunnel.sh`) — bump both together.
- The Caddy binary comes from the official caddyserver.com build service
  (with the route53 plugin compiled in). If that service is ever down during
  a re-provision, build with xcaddy and scp via SSM instead.
