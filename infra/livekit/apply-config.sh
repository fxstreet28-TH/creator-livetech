#!/usr/bin/env bash
#
# Apply infra/livekit/config.yaml to livekit-sg-1 and prove it worked — or put
# the old config back and leave the failure on disk to read.
#
# WHY THIS EXISTS. The config was applied by hand twice on 2026-09-10 and the
# container went into a `Restarting (0)` loop both times. Each rollback happened
# before anyone captured the container's own output, so two outages produced no
# diagnostic at all and the second attempt repeated the first. This script
# removes the choice: logs are written to disk BEFORE the rollback decision is
# taken, so a failed run always leaves evidence behind.
#
# `Restarting (0)` is the signature to understand here. Exit status 0 reads like
# a clean shutdown, but LiveKit v1.7.2's main() prints startup errors WITHOUT
# calling os.Exit(1) (cmd/server/main.go: `if err := app.Run(os.Args); err !=
# nil { fmt.Println(err) }`). So every rejected config exits 0. The status tells
# you nothing; only the log does.
#
# USAGE, from the repo root on the droplet, or with the two files copied over:
#   sudo bash infra/livekit/apply-config.sh --dry-run   # check, change nothing
#   sudo bash infra/livekit/apply-config.sh             # apply, verify, rollback on failure
#
# The API secret is never read, printed, or written by this script. If the live
# config carries an inline `keys:` block, that block is carried across verbatim
# without ever being echoed.

set -euo pipefail

STACK_DIR=${STACK_DIR:-/opt/aurum-livekit}
COMPOSE_FILE="$STACK_DIR/docker-compose.yml"
LIVE_CONFIG="$STACK_DIR/livekit/config.yaml"
SERVICE=${SERVICE:-livekit}
PUBLIC_IP=${PUBLIC_IP:-157.245.158.189}
HEALTH_URL=${HEALTH_URL:-https://livekit.creatorlivetech.com/}
SETTLE_SECONDS=${SETTLE_SECONDS:-25}

SRC_CONFIG=${1:-}
if [ "${SRC_CONFIG:-}" = "--dry-run" ] || [ -z "${SRC_CONFIG:-}" ]; then
  SRC_CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.yaml"
fi
DRY_RUN=0
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY_RUN=1; done

TS=$(date -u +%Y%m%d-%H%M%SZ)
BACKUP="$LIVE_CONFIG.bak.$TS"
CRASH_LOG="/tmp/livekit-apply-$TS.log"
STAGED=$(mktemp)
trap 'rm -f "$STAGED"' EXIT

say()  { printf '\n=== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------- preflight ---
say "Preflight"

[ -f "$COMPOSE_FILE" ] || fail "no compose file at $COMPOSE_FILE"
[ -f "$LIVE_CONFIG" ]  || fail "no live config at $LIVE_CONFIG"
[ -f "$SRC_CONFIG" ]   || fail "no source config at $SRC_CONFIG"
command -v python3 >/dev/null || fail "python3 needed to validate the config"

# The config is validated BEFORE the container is touched. Both faults that
# caused the 2026-09-10 outages are checked here, because catching them now
# costs nothing and catching them later costs an outage.
python3 - "$SRC_CONFIG" <<'PY' || fail "source config rejected — nothing was changed"
import ipaddress, sys, yaml

path = sys.argv[1]
try:
    cfg = yaml.safe_load(open(path))
except Exception as exc:
    sys.exit(f"  not valid YAML: {exc}")

problems = []

# FAULT 1, the one that crashed the container: entries under rtc.ips.includes and
# rtc.ips.excludes are parsed by Go's net.ParseCIDR, which rejects a bare address
# with `invalid CIDR address`. LiveKit turns that into a startup failure.
for key in ("includes", "excludes"):
    for entry in ((cfg.get("rtc") or {}).get("ips") or {}).get(key) or []:
        if "/" not in str(entry):
            problems.append(
                f"  rtc.ips.{key}: {entry!r} has no prefix length. Go's net.ParseCIDR "
                f"rejects a bare address, which fails LiveKit's startup. Write {entry}/32."
            )
            continue
        try:
            ipaddress.ip_network(str(entry), strict=False)
        except ValueError as exc:
            problems.append(f"  rtc.ips.{key}: {entry!r} is not a valid CIDR ({exc}).")

# FAULT 2: bind_addresses narrowed off loopback would cut Caddy's reverse proxy
# to 127.0.0.1:7880 and make signalling unreachable while looking healthy.
binds = cfg.get("bind_addresses")
if binds is not None:
    if not any(b in ("", "0.0.0.0", "127.0.0.1", "::") for b in binds):
        problems.append(
            f"  bind_addresses: {binds!r} does not include loopback or a wildcard. "
            "Caddy reverse-proxies to 127.0.0.1:7880, so signalling would break."
        )

if problems:
    print("Config problems found:")
    print("\n".join(problems))
    sys.exit(1)
print("  YAML valid; rtc.ips entries are CIDR; bind_addresses keeps loopback reachable.")
PY

# FAULT 3, which is what would bite next: this repo's config deliberately ships
# no `keys:` block, and LiveKit refuses to start without API keys — ValidateKeys
# returns "one of key-file or keys must be provided", which again exits 0. If the
# live config carries an inline keys block and the container has no LIVEKIT_KEYS,
# the block is carried across so this stays a one-variable change and the
# compose file does not have to move.
cp "$SRC_CONFIG" "$STAGED"

if grep -qE '^\s*keys\s*:' "$STAGED"; then
  echo "  source config carries its own keys block"
elif dc exec -T "$SERVICE" printenv LIVEKIT_KEYS >/dev/null 2>&1 \
     || grep -q 'LIVEKIT_KEYS' "$COMPOSE_FILE"; then
  echo "  keys come from the LIVEKIT_KEYS environment variable"
elif grep -qE '^\s*key_file\s*:' "$LIVE_CONFIG"; then
  echo "  live config uses key_file; carrying that line across"
  grep -E '^\s*key_file\s*:' "$LIVE_CONFIG" >> "$STAGED"
elif awk '/^[[:space:]]*keys[[:space:]]*:/{found=1} END{exit !found}' "$LIVE_CONFIG"; then
  echo "  carrying the inline keys block over from the live config (not printed)"
  # Copy the `keys:` mapping and its indented body, stopping at the next
  # top-level key. Never echoed to stdout.
  awk '
    /^[[:space:]]*keys[[:space:]]*:/ { inblock=1; print ""; print $0; next }
    inblock && /^[^[:space:]#]/     { inblock=0 }
    inblock                          { print }
  ' "$LIVE_CONFIG" >> "$STAGED"
  grep -qE '^\s*keys\s*:' "$STAGED" || fail "could not carry the keys block across"
else
  fail "no API keys available: the source config has no keys: block, the container
       has no LIVEKIT_KEYS, and the live config has neither keys: nor key_file:.
       LiveKit will refuse to start (ErrKeysNotSet) and exit 0, which Docker
       shows as 'Restarting (0)'. Supply LIVEKIT_KEYS in $COMPOSE_FILE first."
fi

python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' "$STAGED" \
  || fail "staged config is not valid YAML after the keys merge"

say "Current state"
dc ps "$SERVICE" || true

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run — nothing was changed"
  echo "Staged config would differ from live as follows:"
  diff -u "$LIVE_CONFIG" "$STAGED" | sed -E 's/(secret|key)[[:space:]]*:.*/\1: [redacted]/I' || true
  exit 0
fi

# ------------------------------------------------------------------- apply ---
say "Backing up to $BACKUP"
cp -p "$LIVE_CONFIG" "$BACKUP"
ln -sfn "$(basename "$BACKUP")" "$LIVE_CONFIG.bak.latest"

say "Applying"
cat "$STAGED" > "$LIVE_CONFIG"

# --force-recreate rather than `restart`: a plain restart re-reads the mounted
# config but ignores any change to the compose file, so a run that also touched
# compose would silently verify the old settings. Recreating covers both.
say "Recreating the container"
dc up -d --force-recreate "$SERVICE"

# ---------------------------------------------------------------- capture ----
# Logs are written to disk here, before anything is judged and before any
# rollback. This is the step both hand-applied attempts skipped.
say "Watching for $SETTLE_SECONDS s, capturing to $CRASH_LOG"
ok=0
for _ in $(seq 1 "$SETTLE_SECONDS"); do
  sleep 1
  state=$(docker inspect -f '{{.State.Status}}' \
            "$(dc ps -q "$SERVICE")" 2>/dev/null || echo unknown)
  restarts=$(docker inspect -f '{{.RestartCount}}' \
            "$(dc ps -q "$SERVICE")" 2>/dev/null || echo 0)
  [ "$state" = "restarting" ] && break
  [ "${restarts:-0}" -gt 0 ] && break
  if [ "$state" = "running" ] \
     && dc logs "$SERVICE" 2>&1 | grep -q "starting LiveKit server"; then
    ok=1
    break
  fi
done

dc logs "$SERVICE" --tail 200 > "$CRASH_LOG" 2>&1 || true
dc ps "$SERVICE" >> "$CRASH_LOG" 2>&1 || true

# A container that is up but never logged the startup line, or that restarted
# even once, has not started cleanly.
final_state=$(docker inspect -f '{{.State.Status}}' \
                "$(dc ps -q "$SERVICE")" 2>/dev/null || echo unknown)
final_restarts=$(docker inspect -f '{{.RestartCount}}' \
                "$(dc ps -q "$SERVICE")" 2>/dev/null || echo 0)

if [ "$ok" = "1" ] && [ "$final_state" = "running" ] && [ "${final_restarts:-0}" -eq 0 ]; then
  say "Container is up — verifying what it settled on"

  echo "--- startup line ---"
  grep "starting LiveKit server" "$CRASH_LOG" | tail -1 || true

  if grep "starting LiveKit server" "$CRASH_LOG" | tail -1 | grep -q "$PUBLIC_IP"; then
    echo "  nodeIP is $PUBLIC_IP"
  else
    echo "  WARNING: startup line does not mention $PUBLIC_IP — check $CRASH_LOG"
  fi

  # There is deliberately no `grep "using external IPs"` here. LiveKit only logs
  # that on the use_external_ip: true path, which this config does not take, so
  # its absence is expected and proves nothing either way. The candidate list is
  # verified from the viewer side — see remoteCandidates in
  # lib/live/iceDiagnostics.ts, which must report exactly one address.

  echo "--- any error lines ---"
  grep -iE "error|invalid|could not|refus" "$CRASH_LOG" | tail -10 || echo "  none"

  echo "--- signalling through Caddy ---"
  if curl -fsS --max-time 10 -o /dev/null "$HEALTH_URL"; then
    echo "  $HEALTH_URL reachable"
  else
    echo "  WARNING: $HEALTH_URL did not answer — check Caddy before testing viewers"
  fi

  say "Applied. Log kept at $CRASH_LOG, previous config at $BACKUP"
  echo "The vault is still on 'origin'. Nothing viewer-facing has changed yet."
  echo "Next: flip live_delivery_mode to livekit_selfhost on a preview URL and run"
  echo "the five-case iPhone test before leaving it there."
  exit 0
fi

# ------------------------------------------------------------------ rollback --
say "Startup FAILED — state=$final_state restarts=$final_restarts"
echo "This is the diagnostic both earlier attempts lost. LiveKit's own words:"
echo "------------------------------------------------------------------"
grep -iE "error|invalid|could not|refus|panic|fatal" "$CRASH_LOG" | tail -20 \
  || tail -30 "$CRASH_LOG"
echo "------------------------------------------------------------------"
echo "Full log: $CRASH_LOG  (kept — do not delete before reading)"

say "Rolling back to $BACKUP"
cp -p "$BACKUP" "$LIVE_CONFIG"
dc up -d --force-recreate "$SERVICE"
sleep 8
dc ps "$SERVICE"

if docker inspect -f '{{.State.Status}}' "$(dc ps -q "$SERVICE")" 2>/dev/null \
   | grep -q running; then
  echo "Rolled back and running on the previous config."
else
  echo "ROLLBACK DID NOT RECOVER — escalate. Check: dc logs $SERVICE --tail 100"
fi
exit 1
