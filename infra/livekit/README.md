# livekit-sg-1 — self-hosted LiveKit

The droplet that replaces LiveKit Cloud for WebRTC delivery. This directory is
the source of truth for its config; the box itself is at
`/opt/aurum-livekit/`.

| | |
|---|---|
| Host | `livekit-sg-1`, DO Basic Regular 2 vCPU / 4 GB, SGP1 |
| Public IPv4 | `157.245.158.189` |
| DNS | `livekit.creatorlivetech.com` → A record, **Cloudflare proxy OFF** |
| Stack | LiveKit v1.7.2, Redis 7, Caddy 2.8 — all `network_mode: host` |
| Firewall | UFW: 22 LIMIT, 80/443/7881 ALLOW, 50000-60000/udp ALLOW |
| Monitoring | `/opt/aurum-livekit/monitor.sh`, cron every minute → `@aurum_live_origin_alert_bot` |

Cloudflare proxying must stay off. The orange cloud terminates TLS, does not
forward UDP at all, and mangles the WebSocket upgrade Caddy needs for signalling
— turning it on breaks media and the signal channel at the same time.

## What was wrong

An iPhone viewer would play for a few seconds and then drop, about thirty
seconds in, on every attempt. A desktop publisher took ~20 seconds to go live
against LiveKit Cloud's ~5.

LiveKit was advertising all four of the host's addresses as ICE candidates —
the public one plus DigitalOcean's anchor address, the VPC address and Docker's
bridge. Three of those cannot be reached from a phone, so the browser burned its
connectivity-check budget timing out against them (the slow connect) and then
lost the pair it had settled on to a consent-freshness timeout, which RFC 7675
puts at exactly the observed 30 seconds.

The fix is `rtc.ips.includes` in [`config.yaml`](./config.yaml), which is the
only setting that filters the advertised address list itself. The long comment
on that block explains why `use_external_ip`, `node_ip` and
`interfaces.includes` had all been tried and could not work — worth reading
before touching it.

### Two things NOT to do, both of which look like fixes

**Do not narrow `bind_addresses` to the public IP.** Caddy terminates TLS and
reverse-proxies to `127.0.0.1:7880`; a LiveKit that has stopped listening on
loopback is one no viewer can sign in to. Binding and advertising are separate
concerns and only the second is the problem.

**Do not move LiveKit to a bridge network to hide the host's interfaces.** It
would work in principle and costs far more than it returns:

- Publishing `50000-60000/udp` means ~10,000 userland proxy entries and
  iptables rules. Startup goes to tens of seconds and memory climbs steeply.
- Bridge mode puts LiveKit behind Docker's NAT, so it sees only the container
  address and `node_ip` / `use_external_ip` have to be re-derived — the same
  class of bug, one layer further down.
- Caddy in host mode cannot resolve `livekit:7880`, so it would have to move
  onto the bridge too, which means re-testing the Let's Encrypt path.
- Host mode is LiveKit's own recommended deployment. Host mode was never the
  problem; an unconfigured address filter was.

If the port range ever does need publishing, switch LiveKit to a single muxed
UDP port first (`rtc.udp_port: 7882`, dropping `port_range_*`) so it is one
published port rather than ten thousand. That is a good change on its own
merits — fewer candidates, faster gathering, a simpler firewall — but it is a
**separate** change from this one and should not ride along with the A/B test
below. One variable at a time.

## Why the first two attempts took the container down

Both attempts on 2026-09-10 put `aurum-livekit` into a `Restarting (0)` loop
and both were rolled back before anyone captured the container's own output, so
two outages produced no diagnostic. The cause is in the config that was applied,
and it is one missing suffix.

**`rtc.ips.includes` entries are CIDR blocks, not addresses.** LiveKit parses
each one with Go's `net.ParseCIDR`, which requires a prefix length and returns
`invalid CIDR address: 157.245.158.189` for a bare address. That error fails
`NewWebRTCConfig`, which fails startup. Both attempts wrote the bare address.
The fix is `157.245.158.189/32` — one host, so it stays an exact allowlist.

Upstream asserts this in its own tests, which is the shortest proof available
(`mediatransportutil/pkg/rtcconfig`, `Test_IPFilterFromConf`): a bare
`192.168.128.1` under `Includes` is `require.Error`. LiveKit's own dev-mode
path appends `/24` to bind addresses before putting them in `IPs.Includes` for
the same reason.

**`Restarting (0)` was the misleading part.** Exit status 0 reads like a clean
shutdown, so the loop looked like a crash or an OOM rather than a rejected
config. It is neither. LiveKit v1.7.2's `cmd/server/main.go` ends with

```go
if err := app.Run(os.Args); err != nil {
    fmt.Println(err)
}
```

— no `os.Exit(1)`. Every startup error is printed and then returns through a
`main` that exits 0. So on this version the exit code carries no information
about whether the server started: a bad config, missing keys and a clean
shutdown all exit 0, and **only the log distinguishes them**. Anything that
concludes from a status line without reading the log will misdiagnose this
container. A real panic is the one exception — the deferred recover in `main`
does `os.Exit(1)`, so a non-zero code here means a crash, not a config problem.

**The second fault, which had not been reached yet.** This directory's config
ships no `keys:` block on purpose (the header explains why) and expects
`LIVEKIT_KEYS` in the environment. `ValidateKeys` runs *before* the WebRTC
config is built and returns `one of key-file or keys must be provided` when
neither is set — exiting 0 again, indistinguishable at the status line. So
copying this file onto a droplet whose compose file has no `LIVEKIT_KEYS`
fails, and fails first, masking the CIDR error underneath it. Either supply the
environment variable (the full path below) or keep the box's existing inline
keys (the minimal path, or the script, which does it for you).

### What was ruled out, so it is not re-litigated

Every key in `config.yaml` was checked against v1.7.2's config structs — the
decoder runs with `KnownFields(true)`, so one unrecognised key is also a
startup failure. All 22 key paths resolve. In particular none of these is the
problem:

- **`ips.includes` being unsupported in v1.7.2.** It is supported, and it does
  filter: `NewWebRTCConfig` calls `SetIPFilter` from it. Issue #3012 concerns
  `excludes`; issue #3508 is this same CIDR error, misreported as a
  string-versus-list problem.
- **Needing a LiveKit upgrade** (v1.9.x/v1.10.x). Nothing here is fixed by a
  newer version, and `net.ParseCIDR` behaves identically in all of them. An
  upgrade is a fine thing to schedule on its own merits; it is not this fix, and
  bundling it would put an untested version and an untested config into the
  same change.
- **Needing `--node-ip` as a command-line flag.** Issue #4049 is specifically
  about the flag being ignored when `use_external_ip: true`. This config sets
  it false, and on that path `node_ip` from the file is honoured and becomes the
  NAT1To1 host mapping.
- **Needing bridge networking.** Host mode was never implicated — the container
  exited before it gathered a single candidate. The costs are in the section
  above.

## Applying the fix

### Preferred — the script

`apply-config.sh` in this directory does the whole sequence: it validates the
config *before* touching the container (rejecting a missing `/32` and a
`bind_addresses` narrowed off loopback), carries the box's existing inline
`keys:` block across without printing it, backs up, recreates, then **writes
the container's log to `/tmp/livekit-apply-<timestamp>.log` before deciding
anything** and rolls back if startup failed, leaving that log behind to read.
The log-before-rollback ordering is the whole point: it is the step both hand
-applied attempts skipped, which is why two outages taught us nothing.

```bash
cd /opt/aurum-livekit                      # config.yaml + apply-config.sh copied here
sudo bash apply-config.sh --dry-run        # validate and diff, change nothing
sudo bash apply-config.sh                  # apply, verify, roll back on failure
```

It recreates the container rather than `restart`ing it, because a plain restart
re-reads the mounted config but ignores changes to `docker-compose.yml` — so a
run that also touched compose would quietly verify the old settings.

### By hand

SSH from Git Bash on Windows, not PowerShell — PowerShell mangles heredocs.
Bracketed paste breaks multi-line pastes, so keep one session open and paste
each block on its own. The root password is in Supabase Vault as
`livekit_sg_1_root_password`; never put it in a file, a script or a chat log.

```bash
ssh root@157.245.158.189
```

### Minimal path — three lines, one restart

The smallest change that fixes the disconnect. Leaves the inline `keys:` block
where it is, so nothing else about the box moves.

```bash
cd /opt/aurum-livekit
cp livekit/config.yaml livekit/config.yaml.bak.$(date +%Y%m%d-%H%M%S)

# Insert the allowlist into the existing rtc: block, right after node_ip.
python3 - <<'PY'
import re
p = '/opt/aurum-livekit/livekit/config.yaml'
s = open(p).read()
if 'ips:' in s:
    raise SystemExit('an ips: block already exists — edit it by hand instead')
s = s.replace(
    '  node_ip: 157.245.158.189\n',
    '  node_ip: 157.245.158.189\n  ips:\n    includes:\n      - 157.245.158.189/32\n',
    1,
)
open(p, 'w').write(s)
print('patched')
PY

docker compose restart livekit
```

### Full path — adopt this directory's config

Also moves the API secret out of the config file, which is a prerequisite for
the credential rotation that has to happen before the production flip. Copy
`config.yaml` from this directory to `/opt/aurum-livekit/livekit/config.yaml`,
then supply the keys through the environment instead:

```bash
cd /opt/aurum-livekit

# The vault holds livekit_selfhost_api_key and livekit_selfhost_api_secret.
# Read them from the Supabase dashboard and paste them at the prompts — typing
# them into the command line would put the secret in the shell history.
read -rp 'LIVEKIT_API_KEY: '    LK_KEY
read -rsp 'LIVEKIT_API_SECRET: ' LK_SECRET; echo

umask 077
printf 'LIVEKIT_KEYS=%s: %s\n' "$LK_KEY" "$LK_SECRET" > /opt/aurum-livekit/.env
unset LK_SECRET
chmod 600 /opt/aurum-livekit/.env
```

`.env` next to `docker-compose.yml` is read automatically, so the compose
service needs `LIVEKIT_KEYS` passed through:

```yaml
  livekit:
    environment:
      - LIVEKIT_KEYS
```

Then `docker compose up -d livekit`. Confirm the key was picked up before
testing — a LiveKit with no keys starts and refuses every token:

```bash
docker compose logs livekit 2>&1 | grep -i "no keys\|invalid api key" | tail
```

## Verifying, before any device test

**Do not grep for `using external IPs`.** That was the check written for the
old config and it cannot work with this one. LiveKit logs that line only on the
`use_external_ip: true` branch — the branch that STUNs out to discover its own
address — and this config deliberately takes the other one. The line will never
appear, so its absence is not evidence of anything and waiting for it reads as
a failure that is not happening. (It is also where the four-address log in the
bug report came from, which is why it looks like the right thing to grep.)

Three checks, in order of what they actually prove:

```bash
# 1. It is up, which is the thing the broken config could not manage.
docker compose -f /opt/aurum-livekit/docker-compose.yml ps livekit
```

`STATUS` must read `Up`. `Restarting` — with any exit code, `(0)` included —
means the config was rejected; read the log before touching anything else.

```bash
# 2. The address it settled on.
docker compose -f /opt/aurum-livekit/docker-compose.yml logs livekit \
  2>&1 | grep "starting LiveKit server" | tail -1
```

Must carry `nodeIP 157.245.158.189`.

```bash
# 3. Nothing was rejected on the way up.
docker compose -f /opt/aurum-livekit/docker-compose.yml logs livekit \
  2>&1 | grep -iE "error|invalid|could not|refus" | tail
```

Empty. `invalid CIDR address` here means a `/32` went missing again.

None of those three actually observes the candidate list — the server never
logs it on this path. **The candidate list is verified from the viewer**, with
the query at the end of the A/B test section: `remoteCandidates` must hold
exactly one address. Until that query has run, the ICE fix is untested no
matter how clean the server log looks.

If four addresses do still appear there: check indentation (`ips:` is a child
of `rtc:`, two spaces), confirm the container actually restarted (`docker
compose ps` — look at the uptime, not the status), and re-read the log from the
*current* startup rather than a scrollback of the previous one.

Also confirm the reverse proxy still works, since the config touches
`bind_addresses`' neighbourhood:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://livekit.creatorlivetech.com/
```

## The A/B test

Only after the log shows one address. Flip delivery in the Supabase SQL editor:

```sql
SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'live_delivery_mode'),
  'livekit_selfhost'
);
```

Run it against a **preview URL first**, not production. All five must pass:

1. Chrome desktop starts a 720p broadcast at `/creator/live` — creator's preview
   appears within 5–10s. (20s means candidates are still wrong.)
2. iPhone Safari on WiFi opens the session URL — video within 10s, and no
   "กำลังรอสัญญาณจาก Creator".
3. Watch 60s unbroken. No disconnect, no freeze.
4. Desktop switches layout — the phone keeps playing.
5. Phone backgrounds for 3s and returns — video resumes.

Then read what the viewer recorded, which is the point of the diagnostics added
alongside this change — it answers the candidate question from the phone's side,
without SSH:

```sql
SELECT created_at,
       detail->>'event'              AS event,
       detail->>'disconnect_reason'  AS reason,
       detail->'ice_path'->>'remoteAddress'    AS chosen,
       detail->'ice_path'->'remoteCandidates'  AS offered,
       detail->'ice_path'->>'localType'        AS local_type,
       detail->'ice_path'->>'rttMs'            AS rtt_ms
FROM live_viewer_diagnostics
WHERE session_id = '<session id>'
ORDER BY created_at;
```

`offered` is the whole answer. One public address means the server is fixed; if
four still appear, the fix is not live whatever the server log said. A
`disconnect_reason` row with a healthy single-candidate path is a *different*
bug — most likely NAT, and the cue to build the coturn relay rather than to
keep re-reading this config.

## Rollback

Instant and safe. In-flight self-hosted sessions fail closed; new ones land on
the origin path.

```sql
SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'live_delivery_mode'),
  'origin'
);
```

Viewers of a session already open keep working: `live-get-playback-url` reads
the mode from the session row rather than the vault, so flipping the secret no
longer hands in-flight viewers a token their server refuses. It did before —
that was Round 1 of the 2026-09-10 bring-up, and the reason a viewer sat on
"waiting for the creator" forever.

To roll the *server* back, restore the config backup and restart:

```bash
cd /opt/aurum-livekit
ls -t livekit/config.yaml.bak.* | head -1
cp "$(ls -t livekit/config.yaml.bak.* | head -1)" livekit/config.yaml
docker compose restart livekit
```

## Still outstanding

- **Rotate the API key and secret.** They were pasted into a chat log during
  the deploy. Must happen before production is flipped to `livekit_selfhost`.
  The full path above is the prerequisite — a secret in `LIVEKIT_KEYS` can be
  rotated without editing a tracked file.
- **Replace password SSH with a key**, then `PasswordAuthentication no`. The
  root password was handled the same way as the API secret.
- **coturn on its own port**, sharing Caddy's certificate. This is more load-
  bearing than it looks, because of how the viewer's recovery ladder escalates.
  From 8 seconds in, every rung rebuilds the peer connection with
  `iceTransportPolicy: 'relay'` — deliberately, since the failure being
  escalated against is a network that will not carry a direct connection. With
  `turn.enabled: false` and no coturn there is no relay candidate to gather, so
  those rungs cannot connect at all and the first thing that can actually
  recover a self-hosted viewer is the page reload at 35 seconds. On LiveKit
  Cloud the same rungs work, because Cloud runs TURN.

  So a self-hosted viewer's recovery is a 35-second reload where a Cloud
  viewer's is an 8-second relay. That is still recovery, and still better than
  the "live has ended" card this used to show — but it is the gap coturn
  closes, and Thai carrier CGNAT on AIS/True/DTAC will make it routine rather
  than an edge case. Not required for the A/B test, which is on WiFi.
- **Single muxed UDP port** (`rtc.udp_port`), as described above. Do it after
  the A/B test passes, on its own.
