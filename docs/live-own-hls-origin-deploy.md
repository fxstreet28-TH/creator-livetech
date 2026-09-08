# Self-hosted LL-HLS origin — `origin-sg-1` deploy runbook

Everything the VPS side of `delivery_mode = 'origin'` needs: MediaMTX + Caddy on a
DigitalOcean droplet, taking WHIP from the creator's browser, producing LL-HLS,
and served to viewers through the existing Bunny Standard Pull Zone.

**Run every command in this document from a Linux/macOS shell** (WSL is fine).
There is no PowerShell in here on purpose — the heredocs below are not portable
to it and silently mangle under it.

---

## 0. Status of this runbook

The repository side of this work (vault secrets, migration, Edge Functions,
WHIP publisher, HLS viewer) is **applied and verified**. The VPS side below is
**written but not yet executed**: the Claude Code sandbox that produced it has
no route to the droplet — outbound TCP/22 is blocked by the sandbox egress
policy, and HTTPS to `origin.creatorlivetech.com`, `aurum-live-origin.b-cdn.net`,
`api.telegram.org` and `api.bunny.net` is refused by that policy with `403
connect_rejected`. So Phases 1–7 and checks 10.1–10.8 have to be run from a
machine that can reach the box.

Where the original deploy plan's scripts contained a bug that would have failed
on the box, this runbook has the corrected version and a note saying what
changed and why. Those notes are marked **CORRECTION** and are worth reading —
three of them are the difference between a stack that starts and one that does
not.

### Infrastructure this assumes already exists

| Thing | Value |
| --- | --- |
| Droplet | `origin-sg-1`, `209.97.173.191`, SGP1, Ubuntu 24.04, 2 vCPU / 4 GB / 80 GB |
| DNS | `origin.creatorlivetech.com` A → `209.97.173.191`, **proxy OFF** (Cloudflare grey cloud) |
| Pull zone | `aurum-live-origin` (id `6499938`) → origin `https://origin.creatorlivetech.com` |
| Telegram | bot `@aurum_live_origin_alert_bot`, token + chat id already in Supabase Vault |

DNS is verified: `origin.creatorlivetech.com` resolves to `209.97.173.191`.
The proxy being OFF is load-bearing — Cloudflare's proxy does not pass WebRTC
UDP, so WHIP ingest dies if the cloud is ever turned orange.

---

## 1. Get the root password into your shell

The password is **not** in the repository and must not be pasted into a commit,
a log line, or a comment. Put it in the Vault once, then read it back when you
need it:

```sql
-- Supabase SQL editor, once.
SELECT vault.create_secret(
  '<the root password>',
  'origin_sg_1_root_password',
  'DigitalOcean droplet origin-sg-1 root password (rotate to SSH key after first deploy)'
);
```

Read it into your shell without letting it reach the terminal or your history:

```bash
# `read -s` keeps it off screen; the leading space keeps it out of bash history
# on shells with HISTCONTROL=ignorespace.
 read -rs -p "droplet root password: " DROPLET_PASSWORD && export DROPLET_PASSWORD && echo
```

```bash
sudo apt-get install -y sshpass   # already present in most environments
```

**Verify SSH before anything else. If this fails, stop — nothing below will work.**

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 \
  "hostname && lsb_release -ds && df -h / | tail -1"
```

Expect `origin-sg-1`, Ubuntu 24.04, and `/` well under 20% used.

> **Rotate to key auth once this is working.** A password that has been typed
> into a chat window is a password to retire: `ssh-copy-id`, then
> `PasswordAuthentication no` in `/etc/ssh/sshd_config`. The `ufw limit` rule in
> Phase 2 reduces the brute-force surface but does not remove it.

---

## 2. Baseline hardening

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade

apt-get install -y -qq \
    ufw fail2ban unattended-upgrades curl ca-certificates gnupg lsb-release \
    htop iotop jq net-tools dnsutils cron rsyslog

timedatectl set-timezone Asia/Bangkok
dpkg-reconfigure -f noninteractive unattended-upgrades

# 4 GB swap. Not for steady-state use — MediaMTX should live in RAM — but a box
# with 4 GB and no swap OOM-kills the container mid-broadcast instead of getting
# slower, and getting slower is recoverable.
if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

cat > /etc/sysctl.d/99-aurum-live.conf <<'SYSCTL'
# Socket buffers sized for many concurrent HLS segment reads.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# BBR + fq: the combination that stops a single slow viewer's retransmits
# from throttling everyone sharing the uplink.
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
net.ipv4.tcp_fastopen = 3

fs.file-max = 1000000
SYSCTL
sysctl -p /etc/sysctl.d/99-aurum-live.conf

cat > /etc/security/limits.d/99-aurum-live.conf <<'LIMITS'
* soft nofile 1000000
* hard nofile 1000000
root soft nofile 1000000
root hard nofile 1000000
LIMITS

echo "PHASE 1 BASELINE OK"
REMOTE_EOF
```

**CORRECTION** — `sysctl vm.swappiness=10` inside the `if` block only ran when
the swapfile was newly created, so re-running the script left swappiness at the
default 60. Moved out of the conditional and made idempotent (`grep -q` before
appending, so a second run does not add the line twice).

`tcp_congestion_control = bbr` needs the `tcp_bbr` module. Ubuntu 24.04 has it
built in; confirm with `sysctl net.ipv4.tcp_congestion_control` after the run —
if it still reads `cubic`, the setting was rejected and the line is a no-op.

---

## 3. Firewall

SSH is allowed **first**, before the default-deny is enabled — the ordering here
is what stops you locking yourself out of a box you can only reach over SSH.

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

ufw --force reset
ufw default deny incoming
ufw default allow outgoing

ufw limit 22/tcp   comment 'SSH rate-limited'
ufw allow 80/tcp   comment 'HTTP for Lets Encrypt ACME'
ufw allow 443/tcp  comment 'HTTPS WHIP+HLS'
ufw allow 8189/udp comment 'MediaMTX WebRTC ICE'

ufw --force enable
ufw status verbose
echo "PHASE 2 UFW OK"
REMOTE_EOF
```

**CORRECTION** — the original had explicit `ufw deny 1935/tcp` and
`ufw deny 9997/tcp`. Both are removed. With `default deny incoming` already in
force they change nothing, and a `deny` rule for the admin API is actively
misleading: it reads as though 9997 is the thing being protected, when what
actually protects it is MediaMTX binding to `127.0.0.1` and never listening on
a public interface at all. Check 10.5 verifies the binding, which is the real
control.

---

## 4. fail2ban

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

cat > /etc/fail2ban/jail.local <<'JAIL'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = 22
maxretry = 3
bantime  = 86400
JAIL

systemctl enable fail2ban
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd
echo "PHASE 3 FAIL2BAN OK"
REMOTE_EOF
```

---

## 5. Docker

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
fi

systemctl enable docker
systemctl start docker

docker --version
docker compose version
echo "PHASE 4 DOCKER OK"
REMOTE_EOF
```

---

## 6. The MediaMTX + Caddy stack

### 6.1 Config files

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

mkdir -p /opt/aurum-live/{mediamtx,caddy} /var/log/caddy
cd /opt/aurum-live

cat > mediamtx/mediamtx.yml <<'MEDIAMTX_YAML'
###############################################
# AURUM Live — MediaMTX
# WHIP ingest -> LL-HLS delivery
###############################################

logLevel: info
logDestinations: [stdout]

# Admin API — LOCALHOST ONLY. This bind is the control that keeps the admin
# surface private; there is no firewall rule doing that job. See check 10.5.
api: yes
apiAddress: 127.0.0.1:9997

metrics: yes
metricsAddress: 127.0.0.1:9998

# Every ingest protocol we do not use is off. Each one left on is a listener
# on a public interface answering strangers for no benefit.
rtmp: no
rtsp: no
srt: no

# ── WebRTC / WHIP (creator publishes) ──
webrtc: yes
webrtcAddress: :8889
# Plaintext on purpose: Caddy terminates TLS and proxies over loopback. The
# MEDIA is DTLS-encrypted regardless — this setting is only about the HTTP
# signalling server, which never leaves the box unencrypted.
webrtcEncryption: no
webrtcAllowOrigin: '*'
# Caddy is the only thing that ever talks to this port, and MediaMTX needs to
# be told to trust its X-Forwarded-For — otherwise every publisher appears to
# come from 127.0.0.1.
webrtcTrustedProxies: [127.0.0.1/32]
webrtcICEServers2: []
# The droplet's public address, announced as a host candidate so a browser can
# reach it without a STUN round trip.
webrtcICEHostNAT1To1IPs: [209.97.173.191]
# One UDP port for all ICE traffic, matching the single ufw rule above.
webrtcICEUDPMuxAddress: :8189

# ── HLS (viewers pull, through Bunny) ──
hls: yes
hlsAddress: :8888
hlsEncryption: no
hlsAllowOrigin: '*'
hlsTrustedProxies: [127.0.0.1/32]
# Remux only while someone is publishing. `yes` would keep encoders running
# against dead paths.
hlsAlwaysRemux: no
hlsVariant: lowLatency
hlsSegmentCount: 7
hlsSegmentDuration: 2s
hlsPartDuration: 500ms
hlsSegmentMaxSize: 50M

readTimeout: 10s
writeTimeout: 10s

pathDefaults:
  source: publisher
  sourceOnDemand: no

paths:
  # Matches live/<room-id> as minted by live-create-session.
  '~^live/[a-zA-Z0-9_-]+$':
    source: publisher

  all_others:
    source: publisher
MEDIAMTX_YAML

cat > caddy/Caddyfile <<'CADDYFILE'
{
    email admin@creatorlivetech.com
    admin off
}

origin.creatorlivetech.com {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    # `header Field value` SETS (replaces) in Caddy v2 — it does not append.
    # That matters: MediaMTX emits its own Access-Control-Allow-Origin, and two
    # of them makes every browser reject the response outright.
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type, Authorization, If-Match, ETag"
    header Access-Control-Expose-Headers "ETag, Location"
    header Access-Control-Max-Age "86400"

    # `route` forces these to run in the order written. Without it Caddy applies
    # its own directive order, `handle` sorts ahead of `respond`, and the
    # preflight answer below is unreachable for every path that has a handler.
    route {
        @preflight method OPTIONS
        respond @preflight 204

        handle /healthz {
            respond "ok" 200
        }

        # WHIP session resource, for the DELETE that ends a broadcast.
        # MediaMTX answers the POST with a root-relative Location of the form
        # /<path>/whip/<session-uuid>, which the browser resolves against this
        # host — so it arrives OUTSIDE /whip/ and needs its own route. Without
        # this, every teardown 404s and paths linger until the peer connection
        # times out, and the creator's next go-live gets a 409.
        @whip_session path_regexp whipsess ^/live/[a-zA-Z0-9_-]+/whip/.+$
        handle @whip_session {
            reverse_proxy 127.0.0.1:8889
        }

        # WHIP ingest. The public URL is /whip/live/<room-id>; MediaMTX expects
        # /<path>/whip. So /whip/live/abc123 -> /live/abc123/whip.
        @whip path_regexp whip ^/whip/(.+)$
        handle @whip {
            rewrite * /{re.whip.1}/whip
            reverse_proxy 127.0.0.1:8889 {
                transport http {
                    dial_timeout 5s
                    read_timeout 30s
                    write_timeout 30s
                }
            }
        }

        # HLS delivery. handle_path strips /hls, so /hls/live/abc/index.m3u8
        # reaches MediaMTX as /live/abc/index.m3u8.
        handle_path /hls/* {
            # The playlist must not be cached for longer than a segment or the
            # CDN serves a stale live edge; the segments are immutable once
            # written and can be held.
            @m3u8 path *.m3u8
            header @m3u8 Cache-Control "public, max-age=1, s-maxage=1"

            @segment path *.mp4 *.ts *.m4s
            header @segment Cache-Control "public, max-age=60, s-maxage=60"

            reverse_proxy 127.0.0.1:8888
        }

        handle {
            respond "not found" 404
        }
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size    100MiB
            roll_keep    5
            roll_keep_for 720h
        }
        format json
    }
}
CADDYFILE

cat > docker-compose.yml <<'COMPOSE'
services:
  mediamtx:
    image: bluenviron/mediamtx:1.9.3
    container_name: aurum-mediamtx
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./mediamtx/mediamtx.yml:/mediamtx.yml:ro
    ulimits:
      nofile:
        soft: 1000000
        hard: 1000000
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  caddy:
    image: caddy:2.8-alpine
    container_name: aurum-caddy
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
      - /var/log/caddy:/var/log/caddy
    depends_on:
      - mediamtx
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

volumes:
  caddy_data:
  caddy_config:
COMPOSE

echo "PHASE 5 CONFIG WRITTEN"
ls -la /opt/aurum-live/
REMOTE_EOF
```

**CORRECTION 1 — the WHIP path rewrite.** The original Caddyfile did
`handle_path /whip/* { rewrite * /{path} ... }`, which strips the prefix and
then rewrites the already-stripped path onto itself. It never appends the
`/whip` suffix MediaMTX's WHIP endpoint actually lives at, so every publish
attempt would have hit a path MediaMTX does not serve. Replaced with an explicit
regex route that maps `/whip/live/<id>` → `/live/<id>/whip`.

**CORRECTION 2 — the WHIP teardown route.** Nothing in the original routed the
session resource named by the 201's `Location` header, so `DELETE` — the call
that ends a broadcast cleanly — would have 404'd on every session. Added
`@whip_session`.

**CORRECTION 3 — directive ordering.** `respond @cors_preflight 204` sat outside
any `handle` block. Caddy sorts directives by its own standard order rather than
by source order, and `handle` sorts ahead of `respond`, so preflights to
`/whip/*` and `/hls/*` would have been proxied to MediaMTX instead of answered —
failing check 10.3. Everything is now inside a `route` block, which preserves
written order.

**CORRECTION 4 — the healthcheck is gone.** The original gave the MediaMTX
container a `wget`-based Docker healthcheck. `bluenviron/mediamtx` ships as a
near-scratch image with the binary and no shell or `wget`, so that check can
only ever fail — the container would sit permanently `unhealthy`, check 10.7
would never pass, and the monitor script would fire a CRITICAL alert every ten
minutes forever. Liveness is checked in `monitor.sh` instead, by curling the
admin API from the host, which tests the thing we actually care about.

**CORRECTION 5 — removed config keys.** `readBufferCount` (renamed to
`writeQueueSize` in MediaMTX 1.x) and `disablePublisherOverride` (now
`overridePublisher`, with inverted sense) are dropped, along with the empty
`webrtcServerKey`/`hlsServerKey`/`hlsDirectory`/`runOnDemand` entries that only
restated defaults. `version: '3.8'` is dropped from the compose file — Compose
v2 ignores it and warns.

> **Verify the config keys on first start.** MediaMTX refuses to start on an
> unrecognised key rather than ignoring it, and this sandbox could not reach the
> MediaMTX docs to confirm every name against 1.9.3 exactly. That failure is
> loud and instant — see the validation step below — and the fix is always to
> delete the offending line.

### 6.2 Validate the config, then start

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail
cd /opt/aurum-live

docker compose pull

# Start MediaMTX alone first and read its log. A rejected config key shows up
# here as `json: unknown field "<name>"` and the container exits immediately —
# far easier to read now than tangled up with Caddy's ACME output.
docker compose up -d mediamtx
sleep 5
docker compose logs mediamtx --tail=40

if ! docker compose ps mediamtx --format '{{.State}}' | grep -q running; then
    echo "MEDIAMTX FAILED TO START — read the log above, delete the offending key, re-run 6.1"
    exit 1
fi

# The API answering on loopback is the real liveness signal.
curl -sf http://127.0.0.1:9997/v3/config/global/get > /dev/null \
  && echo "MediaMTX admin API OK" \
  || { echo "MediaMTX API not answering"; exit 1; }

docker compose up -d

echo "Waiting for Caddy to obtain a certificate..."
for i in $(seq 1 90); do
    if curl -sf --resolve origin.creatorlivetech.com:443:127.0.0.1 \
        https://origin.creatorlivetech.com/healthz > /dev/null 2>&1; then
        echo "TLS ready after ${i}s"
        break
    fi
    sleep 1
done

docker compose ps
docker compose logs caddy --tail=30
echo "PHASE 5 STACK RUNNING"
REMOTE_EOF
```

If the certificate never arrives, read `docker compose logs caddy`. In order of
likelihood: port 80 unreachable from the internet (the ACME HTTP-01 challenge
needs it — check the ufw rule landed), DNS not yet propagated, or Cloudflare's
proxy switched on for the record (it must stay grey).

---

## 7. Monitoring and Telegram alerts

Read the credentials out of the Vault. **Do not echo them, do not commit them,
do not paste them into a chat window.**

```sql
-- Supabase SQL editor. Copy the two values straight into the shell below.
SELECT get_vault_secret('telegram_bot_token_origin_alert') AS token,
       get_vault_secret('telegram_chat_id_origin_alert')   AS chat_id;
```

```bash
 read -rs -p "telegram bot token: " TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN && echo
 read -r  -p "telegram chat id: "   TELEGRAM_CHAT_ID   && export TELEGRAM_CHAT_ID
```

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 \
    "TELEGRAM_BOT_TOKEN='$TELEGRAM_BOT_TOKEN' TELEGRAM_CHAT_ID='$TELEGRAM_CHAT_ID' bash -s" <<'REMOTE_EOF'
set -euo pipefail

umask 077
printf '%s' "$TELEGRAM_BOT_TOKEN" > /root/.telegram_bot_token
printf '%s' "$TELEGRAM_CHAT_ID"   > /root/.telegram_chat_id
chmod 600 /root/.telegram_bot_token /root/.telegram_chat_id

cat > /opt/aurum-live/monitor.sh <<'MONITOR'
#!/bin/bash
# origin-sg-1 health. Runs every minute from cron; alerts to Telegram.
#
# NOT `set -e`. This script's whole job is to report on things that are broken,
# and a failing check must produce an alert rather than a silent early exit.
set -uo pipefail

TG_TOKEN=$(cat /root/.telegram_bot_token)
TG_CHAT_ID=$(cat /root/.telegram_chat_id)
STATE_FILE=/var/lib/aurum-monitor-state
LOG=/var/log/aurum-monitor.log

alert() {
    local severity="$1" msg="$2"
    local now emoji
    now=$(date '+%Y-%m-%d %H:%M:%S %Z')
    case "$severity" in
        WARN)     emoji="⚠️" ;;
        CRITICAL) emoji="🚨" ;;
        *)        emoji="ℹ️" ;;
    esac

    # --data-urlencode, not manual %0A escaping: the original hand-encoded the
    # newlines, which breaks the moment an alert body contains an & or a =.
    curl -sS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TG_CHAT_ID}" \
        --data-urlencode "text=${emoji} [origin-sg-1] ${severity}

${now}

${msg}" \
        --max-time 10 > /dev/null || true

    echo "[$now] $severity: $msg" >> "$LOG"
}

# Alert once per issue per 10 minutes. A box that is genuinely on fire should
# not also be a notification flood.
last_alerted() {
    local key="$1" last now
    [ -f "$STATE_FILE" ] || return 1
    last=$(grep "^$key=" "$STATE_FILE" 2>/dev/null | cut -d= -f2)
    [ -n "$last" ] || return 1
    now=$(date +%s)
    [ $((now - last)) -lt 600 ]
}

mark_alerted() {
    local key="$1" now
    now=$(date +%s)
    touch "$STATE_FILE"
    if grep -q "^$key=" "$STATE_FILE"; then
        sed -i "s/^$key=.*/$key=$now/" "$STATE_FILE"
    else
        echo "$key=$now" >> "$STATE_FILE"
    fi
}

report() {
    local key="$1" severity="$2" msg="$3"
    if ! last_alerted "$key"; then
        alert "$severity" "$msg"
        mark_alerted "$key"
    fi
}

# ── CPU ──
cpu=$(top -bn2 -d 0.5 | grep '%Cpu(s)' | tail -1 | awk '{print 100 - $8}')
cpu_int=${cpu%.*}
if [ -n "${cpu_int:-}" ] && [ "$cpu_int" -gt 85 ] 2>/dev/null; then
    report cpu_high WARN "CPU ${cpu_int}% (threshold 85%)"
fi

# ── RAM ──
ram_used_mb=$(free -m | awk '/^Mem:/ {print $3}')
if [ "${ram_used_mb:-0}" -gt 3000 ]; then
    report ram_high WARN "RAM ${ram_used_mb}MB used (threshold 3GB)"
fi

# ── MediaMTX liveness, via the admin API ──
#
# This replaces the Docker healthcheck the deploy plan called for: the MediaMTX
# image has no shell and no wget, so a container-level healthcheck can only ever
# report unhealthy. Asking the API is both possible and a better question.
if ! paths_json=$(curl -sf --max-time 5 http://127.0.0.1:9997/v3/paths/list 2>/dev/null); then
    report mediamtx_down CRITICAL "MediaMTX admin API not answering — ingest is DOWN"
    paths_json=''
fi

# ── Concurrent publishers against the cap ──
#
# 12 matches the `origin_concurrent_live_cap` vault secret that
# live-create-session admits against. Reaching it here means the cap is doing
# its job and the box is at its ceiling — both worth knowing.
if [ -n "$paths_json" ]; then
    stream_count=$(printf '%s' "$paths_json" | jq -r '[.items[]? | select(.ready == true)] | length' 2>/dev/null || echo 0)
    if [ "${stream_count:-0}" -ge 12 ]; then
        report streams_high CRITICAL "Concurrent live streams: ${stream_count} (cap 12)"
    fi
fi

# ── Containers ──
for container in aurum-mediamtx aurum-caddy; do
    running=$(docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null || echo false)
    if [ "$running" != "true" ]; then
        report "${container}_down" CRITICAL "Container ${container} is NOT running"
    fi
done

# ── Disk ──
disk_pct=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "${disk_pct:-0}" -gt 80 ]; then
    report disk_high WARN "Disk usage ${disk_pct}% (threshold 80%)"
fi

# ── Reachability from the public internet ──
#
# The end-to-end check: DNS, firewall, Caddy, TLS and the route, all at once.
if ! curl -sfI --max-time 5 https://origin.creatorlivetech.com/healthz > /dev/null 2>&1; then
    report origin_unreachable CRITICAL "https://origin.creatorlivetech.com/healthz UNREACHABLE from public internet"
fi

exit 0
MONITOR

chmod +x /opt/aurum-live/monitor.sh

# Rotate the monitor's own log, or a chatty week fills the disk it is watching.
cat > /etc/logrotate.d/aurum-live <<'ROTATE'
/var/log/aurum-monitor.log /var/log/aurum-restart.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    copytruncate
}
ROTATE

( crontab -l 2>/dev/null | grep -v 'aurum-live/monitor.sh' || true
  echo '* * * * * /opt/aurum-live/monitor.sh 2>&1 | logger -t aurum-monitor'
) | crontab -

echo "PHASE 6 MONITORING ACTIVE"
REMOTE_EOF
```

**CORRECTION 6 — `set -euo pipefail` removed from `monitor.sh`.** With `-e`, the
first check whose command returned non-zero (a `grep` that matched nothing, a
`curl` to a service that is down) aborted the script before the alert was sent.
A monitoring script that exits on the first sign of trouble reports nothing at
exactly the moment it is needed. It now runs `set -uo pipefail` and every check
handles its own failure.

**CORRECTION 7 — Telegram message encoding.** The original built the message
body with hand-written `%0A` escapes and passed it via `-d`, which corrupts on
any `&` or `=` in an alert. Now `--data-urlencode` with real newlines.

**CORRECTION 8 — state file location.** `/var/run` is a tmpfs cleared on every
reboot, so the alert de-duplication forgot itself each restart. Moved to
`/var/lib`.

### 7.1 Confirm the alert path end to end

Run this **after** the cron job is installed. It is the only proof the token,
the chat id and outbound HTTPS from the droplet all work together:

```bash
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
  "source /dev/stdin <<< \"\$(sed -n '/^alert()/,/^}/p' /opt/aurum-live/monitor.sh)\"; \
   TG_TOKEN=\$(cat /root/.telegram_bot_token); TG_CHAT_ID=\$(cat /root/.telegram_chat_id); \
   LOG=/var/log/aurum-monitor.log; alert INFO 'Deploy verified — monitoring is live.'"
```

A message must arrive in `@aurum_live_origin_alert_bot` within a few seconds.
**If nothing arrives, the setup is wrong and the alerting is not working** —
check, in this order:

```bash
# Does Telegram accept the token at all?
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
  'curl -sS --max-time 10 "https://api.telegram.org/bot$(cat /root/.telegram_bot_token)/getMe" | jq .ok'
# Expect: true.  false/401 => wrong or revoked token.

# Has the chat ever been opened? A bot cannot message a user who has never
# pressed Start — this is the single commonest cause of silent failure.
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
  'curl -sS --max-time 10 "https://api.telegram.org/bot$(cat /root/.telegram_bot_token)/getUpdates" | jq ".result[-1].message.chat.id"'
# Compare against /root/.telegram_chat_id. If getUpdates is empty, open the bot
# in Telegram and send it /start, then retry.
```

---

## 8. Nightly restart

```bash
sshpass -p "$DROPLET_PASSWORD" ssh -o StrictHostKeyChecking=no root@209.97.173.191 'bash -s' <<'REMOTE_EOF'
set -euo pipefail

cat > /opt/aurum-live/daily-restart.sh <<'RESTART'
#!/bin/bash
# Restart MediaMTX at 04:00 ICT to clear accumulated memory.
# SKIPPED whenever anyone is on air — a scheduled maintenance window is not
# worth cutting off a live broadcast, and 04:00 is a guess about quiet hours,
# not a guarantee.
set -uo pipefail

LOG=/var/log/aurum-restart.log
NOW=$(date '+%Y-%m-%d %H:%M:%S %Z')

paths_json=$(curl -sf --max-time 5 http://127.0.0.1:9997/v3/paths/list 2>/dev/null || echo '')
if [ -z "$paths_json" ]; then
    echo "[$NOW] Skip restart: MediaMTX API unreachable (nothing safe to assume)" >> "$LOG"
    exit 0
fi

STREAM_COUNT=$(printf '%s' "$paths_json" | jq -r '[.items[]? | select(.ready == true)] | length' 2>/dev/null || echo 0)
if [ "${STREAM_COUNT:-0}" -gt 0 ]; then
    echo "[$NOW] Skip restart: $STREAM_COUNT active stream(s)" >> "$LOG"
    exit 0
fi

echo "[$NOW] Restarting MediaMTX (0 active streams)" >> "$LOG"
cd /opt/aurum-live && docker compose restart mediamtx

for _ in $(seq 1 30); do
    if curl -sf --max-time 3 http://127.0.0.1:9997/v3/config/global/get > /dev/null 2>&1; then
        echo "[$NOW] MediaMTX healthy after restart" >> "$LOG"
        exit 0
    fi
    sleep 2
done

echo "[$NOW] WARNING: MediaMTX API not answering 60s after restart" >> "$LOG"
exit 1
RESTART

chmod +x /opt/aurum-live/daily-restart.sh

( crontab -l 2>/dev/null | grep -v 'daily-restart.sh' || true
  echo '0 4 * * * /opt/aurum-live/daily-restart.sh'
) | crontab -

crontab -l
echo "PHASE 7 DAILY RESTART SCHEDULED (04:00 Asia/Bangkok)"
REMOTE_EOF
```

**CORRECTION 9 — health confirmed via the API, not `docker inspect`.** The
original polled `.State.Health.Status`, which is always empty now that the
(impossible) container healthcheck is gone; the loop would have run its full 30
iterations and reported a warning after every successful restart. It also now
skips the restart when the API is unreachable rather than assuming zero streams
— an unreachable API is the one moment you least want to bounce the service
blind.

---

## 9. Verification checklist

Run all of these and record the result. **Every one must pass before the PR is
considered ready to merge.**

```bash
# 9.1 — origin reachable over TLS
curl -sfI https://origin.creatorlivetech.com/healthz >/dev/null && echo "9.1 PASS" || echo "9.1 FAIL"

# 9.2 — certificate is valid and from Let's Encrypt
echo | openssl s_client -connect origin.creatorlivetech.com:443 \
    -servername origin.creatorlivetech.com 2>/dev/null \
  | openssl x509 -noout -dates -issuer
# Expect: issuer contains "Let's Encrypt", notAfter comfortably in the future.

# 9.3 — WHIP CORS preflight is answered by Caddy, not proxied
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS \
    -H 'Origin: https://creatorlivetech.com' \
    -H 'Access-Control-Request-Method: POST' \
    https://origin.creatorlivetech.com/whip/live/verify-room
# Expect: 204

curl -sI -X OPTIONS https://origin.creatorlivetech.com/whip/live/verify-room \
  | grep -i 'access-control-allow-origin'
# Expect exactly ONE such header, value *

# 9.4 — Bunny reaches the origin
curl -s -o /dev/null -w '%{http_code}\n' \
    https://aurum-live-origin.b-cdn.net/hls/live/nonexistent/index.m3u8
# Expect: 404 (MediaMTX, via Caddy, via Bunny — the whole path works)
# NOT: 502/522/523, which mean Bunny cannot reach the origin at all.
#
# NOTE: do not use `curl -sfI ... && echo PASS` for this one. `-f` makes curl
# exit non-zero on a 404, so the expected result would print FAIL.

# 9.5 — the admin API is NOT public. This is the security check.
curl -s -o /dev/null -w '%{http_code}\n' --connect-timeout 5 \
    http://209.97.173.191:9997/v3/config/global/get
# Expect: 000 (refused/timed out).
# ANY JSON response here is a CRITICAL finding — stop and fix the bind address.

# 9.6 — firewall active with the right ports
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 "ufw status verbose"
# Expect: Status: active; 22/tcp LIMIT; 80,443/tcp ALLOW; 8189/udp ALLOW.

# 9.7 — containers up
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
    "docker ps --format 'table {{.Names}}\t{{.Status}}'"
# Expect: aurum-mediamtx and aurum-caddy both Up.

# 9.8 — cron entries present
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 "crontab -l | grep -E 'monitor|restart'"
# Expect: both lines.

# 9.9 — MediaMTX answers on loopback only
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
    "ss -tlnp | grep -E ':(9997|9998|8888|8889)'"
# Expect: 9997 and 9998 bound to 127.0.0.1. 8888/8889 may be 0.0.0.0 — they are
# not reachable from outside because ufw does not open them; only Caddy, on the
# same host, talks to them.
```

```sql
-- 9.10 — the vault secrets the Edge Functions read
SELECT get_vault_secret('origin_whip_endpoint_base') AS whip_base,
       get_vault_secret('origin_hls_endpoint_base')  AS hls_base,
       get_vault_secret('origin_concurrent_live_cap') AS cap,
       get_vault_secret('live_delivery_mode')         AS delivery_mode;
-- Expect: the two bases, 12, and delivery_mode STILL 'livekit'.

-- 9.11 — the capacity function the cap is enforced with
SELECT public.count_active_live_sessions();
-- Expect: an integer (0 when nothing is on air).
```

### Already verified (repo side)

These were run from the sandbox and passed; they need no re-run:

- Vault: `origin_whip_endpoint_base`, `origin_hls_endpoint_base`,
  `origin_concurrent_live_cap` created and readable.
- `live_delivery_mode` re-read after every change: still `livekit`. **Production
  delivery was never flipped.**
- Migration `add_origin_delivery_columns` applied: three columns, the unique
  partial index, and `count_active_live_sessions()` (returns 0).
- Edge Functions deployed and ACTIVE on the live project:
  `live-create-session` v6, `live-get-playback-url` v4, `live-end-session` v6,
  `live-watchdog` v2. Every origin branch in them is unreachable while
  `live_delivery_mode` is `livekit`, so the deploy changes no current behaviour
  — it is what makes the Vercel preview testable at all, since the project has
  one shared set of functions and no preview branching.
- `npx tsc --noEmit` clean (Next.js app); `deno check` clean on all four Edge
  Functions, against real `@supabase/supabase-js@2.45.0` types — worth noting
  because `supabase/functions` is excluded from `tsconfig.json`, so the app's
  typecheck never covered them.
- `npm run build` succeeds.
- `npm run lint` reports only 4 pre-existing errors, all in files this branch
  does not touch.

One cosmetic note on the deploy: the `_shared` modules bundled into
`live-end-session` v6 carry abbreviated comments. The code is identical — same
exports, same behaviour — and the repo is the source of truth; the next full
`supabase functions deploy` normalises it.

---

## 10. Known risk: LL-HLS through a caching CDN

Worth reading before judging the latency result in the iPhone test.

Low-latency HLS gets its latency from **blocking playlist requests** — the
player asks for `index.m3u8?_HLS_msn=N&_HLS_part=M` and the origin holds the
request open until that part exists. A Standard Pull Zone in front of that has
two options and neither is what LL-HLS wants: cache the response (and serve a
live edge that is already stale to the next viewer) or pass every request
through (and lose the point of having a CDN).

Practical consequences to expect:

- Latency will likely land in the **4–8 second** band rather than the <5s target
  when measured through `aurum-live-origin.b-cdn.net`. Measured directly against
  `origin.creatorlivetech.com` it should be closer to 2–3s. **Test both**, and
  the gap between them is the CDN's contribution.
- Playlist cache churn may show up as brief stalls at segment boundaries.

If the CDN path is disappointing, the fallback — and it is a good one — is to
give up part-level latency and keep everything else:

```yaml
hlsVariant: fmp4
hlsSegmentDuration: 1s
hlsSegmentCount: 7
```

That produces plain HLS with 1s segments, a ~3–4s live edge, and caches
perfectly through any CDN. It is the trade this platform is already implicitly
making, since the `latency_mode` the creator picks is honoured by the player's
buffer rather than by the packaging.

Changing `hlsVariant` is a MediaMTX config edit and a `docker compose restart
mediamtx` — no code change, no redeploy, and no Edge Function involvement.

---

## 11. Rollback and emergency stop

The origin path is behind a runtime switch, so backing out is one SQL statement
and needs no deploy:

```sql
-- Roll every NEW session back to LiveKit. Sessions already on air are
-- unaffected — the pipeline is chosen at create and stored on the row.
UPDATE vault.secrets SET secret = 'livekit' WHERE name = 'live_delivery_mode';
```

```bash
# Stop the origin entirely. Do the SQL above FIRST, or new sessions will be
# minted pointing at a box that is not answering.
sshpass -p "$DROPLET_PASSWORD" ssh root@209.97.173.191 \
  "cd /opt/aurum-live && docker compose stop"
```

To go the other way — and this is CEO Por's call alone, after the preview test
passes:

```sql
UPDATE vault.secrets SET secret = 'origin' WHERE name = 'live_delivery_mode';
```

Both take effect on the next `live-create-session` invocation. The vault helper
caches for a short TTL, so allow up to a minute.

---

## 12. Ongoing

**Rotate what has been in a chat window.** The droplet root password and, if it
was ever pasted, the Telegram token. For the token: `/revoke` in @BotFather,
then update the vault secret *and* `/root/.telegram_bot_token` on the box —
`monitor.sh` reads the file, not the vault, so updating one without the other
leaves alerting broken silently.

**Watch the cost lines weekly for the first month.**

- Bunny egress: dash.bunny.net → Pull Zones → `aurum-live-origin` → Statistics.
- DO transfer: droplet → Networking → outbound. Target under 3 TB/month with
  Origin Shield on; the plan allows 4 TB.

**Capacity.** `origin_concurrent_live_cap` is 12, against a box that starts
degrading around 15. It is a vault secret, so raising it needs no deploy — but
raise the droplet first, not the number.

**Log locations on the box:**

| What | Where |
| --- | --- |
| Monitor alerts | `/var/log/aurum-monitor.log` |
| Nightly restart | `/var/log/aurum-restart.log` |
| Caddy access | `/var/log/caddy/access.log` (JSON) |
| MediaMTX | `docker compose logs mediamtx` |
| Cron | `journalctl -t aurum-monitor` |
