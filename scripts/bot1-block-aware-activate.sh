#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@47.251.26.212}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:-2222}"
REMOTE_DIR="${REMOTE_DIR:-/opt/42space}"
PROFILE_ENV="${PROFILE_ENV:-/etc/42space/profiles/42space.env}"
APPLY="${APPLY:-0}"
CONFIRM="${CONFIRM_BOT1_BLOCK_AWARE:-}"
INSTALL_EVIDENCE_TIMER="${INSTALL_EVIDENCE_TIMER:-1}"

SSH=(ssh -p "$REMOTE_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10)
RSYNC_RSH="ssh -p ${REMOTE_SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

cd "$ROOT_DIR"

if [[ "$PROFILE_ENV" != "/etc/42space/profiles/42space.env" ]]; then
  echo "Refusing to operate on non-Bot1 profile env: ${PROFILE_ENV}" >&2
  exit 2
fi

cat <<PLAN
Bot1 block-aware activation plan
- host: ${REMOTE_HOST}
- app: ${REMOTE_DIR}
- profile env: ${PROFILE_ENV}
- mode: OPEN_BROADCAST_MODE=block_aware_20s
- arm: OPEN_BROADCAST_DELAY_MS=19900
- nominal target: T+19.905s (lead 95ms to the T+20.000s boundary)
- pre-target release: 2 fresh T+19s timestamp heads inside the final 120ms window, never before the 19900ms arm
- event service to restart: 42space-event@42space.service
- evidence/calibration timers install: ${INSTALL_EVIDENCE_TIMER}
- apply: ${APPLY}
PLAN

npm run verify

echo "Current remote Bot1 timing readback:"
"${SSH[@]}" "$REMOTE_HOST" "PROFILE_ENV='$PROFILE_ENV' bash -se" <<'REMOTE_READ'
set -euo pipefail
python3 - <<'PY'
import pathlib
path = pathlib.Path(__import__("os").environ["PROFILE_ENV"])
data = {}
for raw in path.read_text(errors="ignore").splitlines():
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    data[key] = value.strip().strip('"').strip("'")
for key in [
    "BOT_NAME",
    "EVENT_DISCOVERY",
    "OPEN_BROADCAST_MODE",
    "OPEN_BROADCAST_DELAY_MS",
    "OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS",
    "OPEN_BROADCAST_BLOCK_AWARE_LEAD_MS",
    "OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_SEND_MS",
    "GAS_PRICE_GWEI",
    "AUTO_SELL_GAS_PRICE_GWEI",
    "AUTO_SELL_STRATEGY",
    "AUTO_SELL_STOP_LOSS_ENABLED",
]:
    print(f"{key}={data.get(key, '')}")
PY
REMOTE_READ

if [[ "$APPLY" != "1" ]]; then
  cat <<'DRYRUN'
Dry run only. No production files were changed.

To apply, run:
  APPLY=1 CONFIRM_BOT1_BLOCK_AWARE=enable-bot1-block-aware scripts/bot1-block-aware-activate.sh
DRYRUN
  exit 0
fi

if [[ "$CONFIRM" != "enable-bot1-block-aware" ]]; then
  echo "Refusing to apply: set CONFIRM_BOT1_BLOCK_AWARE=enable-bot1-block-aware" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

"${SSH[@]}" "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' PROFILE_ENV='$PROFILE_ENV' STAMP='$STAMP' bash -se" <<'REMOTE_BACKUP'
set -euo pipefail
test -d "$REMOTE_DIR"
test -f "$PROFILE_ENV"
mkdir -p "$REMOTE_DIR/backups/block-aware-$STAMP"
cp -a "$PROFILE_ENV" "$REMOTE_DIR/backups/block-aware-$STAMP/$(basename "$PROFILE_ENV").bak"
cp -a "$REMOTE_DIR/src/config.js" "$REMOTE_DIR/backups/block-aware-$STAMP/config.js.bak"
cp -a "$REMOTE_DIR/src/event-sniper.js" "$REMOTE_DIR/backups/block-aware-$STAMP/event-sniper.js.bak"
if [ -f "$REMOTE_DIR/scripts/bot3-buy-rank-evidence.js" ]; then
  cp -a "$REMOTE_DIR/scripts/bot3-buy-rank-evidence.js" "$REMOTE_DIR/backups/block-aware-$STAMP/bot3-buy-rank-evidence.js.bak"
fi
if [ -f "$REMOTE_DIR/scripts/bot1-block-aware-calibrate.js" ]; then
  cp -a "$REMOTE_DIR/scripts/bot1-block-aware-calibrate.js" "$REMOTE_DIR/backups/block-aware-$STAMP/bot1-block-aware-calibrate.js.bak"
fi
if [ -f "$REMOTE_DIR/package.json" ]; then
  cp -a "$REMOTE_DIR/package.json" "$REMOTE_DIR/backups/block-aware-$STAMP/package.json.bak"
fi
echo "backup=$REMOTE_DIR/backups/block-aware-$STAMP"
REMOTE_BACKUP

rsync -az \
  --relative \
  -e "$RSYNC_RSH" \
  ./src/config.js \
  ./src/event-sniper.js \
  ./scripts/bot1-block-aware-calibrate.js \
  ./scripts/bot3-buy-rank-evidence.js \
  ./package.json \
  ./ops/42space-bot1-block-aware-calibration.service \
  ./ops/42space-bot1-block-aware-calibration.timer \
  ./ops/42space-bot1-buy-rank-evidence.service \
  ./ops/42space-bot1-buy-rank-evidence.timer \
  "$REMOTE_HOST:$REMOTE_DIR/"

"${SSH[@]}" "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' PROFILE_ENV='$PROFILE_ENV' INSTALL_EVIDENCE_TIMER='$INSTALL_EVIDENCE_TIMER' bash -se" <<'REMOTE_APPLY'
set -euo pipefail
cd "$REMOTE_DIR"

node --check src/config.js
node --check src/event-sniper.js
node --check scripts/bot1-block-aware-calibrate.js
node --check scripts/bot3-buy-rank-evidence.js
node src/event-sniper.js self-test >/tmp/bot1-block-aware-self-test.json

python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["PROFILE_ENV"])
updates = {
    "OPEN_BROADCAST_MODE": "block_aware_20s",
    "OPEN_BROADCAST_DELAY_MS": "19900",
    "OPEN_BROADCAST_BLOCK_TARGET_OFFSET_MS": "20000",
    "OPEN_BROADCAST_BLOCK_AWARE_LEAD_MS": "95",
    "OPEN_BROADCAST_BLOCK_AWARE_MAX_WAIT_MS": "250",
    "OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_COUNT": "2",
    "OPEN_BROADCAST_BLOCK_AWARE_PRE_TARGET_SEND_MS": "120",
    "OPEN_BROADCAST_BLOCK_AWARE_HEAD_MAX_AGE_MS": "2000",
}
lines = path.read_text(errors="ignore").splitlines()
seen = set()
next_lines = []
for line in lines:
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        next_lines.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in updates:
        next_lines.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        next_lines.append(line)
for key, value in updates.items():
    if key not in seen:
        next_lines.append(f"{key}={value}")
path.write_text("\n".join(next_lines) + "\n")
PY

if [ "$INSTALL_EVIDENCE_TIMER" = "1" ]; then
  cp -a ops/42space-bot1-block-aware-calibration.service /etc/systemd/system/42space-bot1-block-aware-calibration.service
  cp -a ops/42space-bot1-block-aware-calibration.timer /etc/systemd/system/42space-bot1-block-aware-calibration.timer
  cp -a ops/42space-bot1-buy-rank-evidence.service /etc/systemd/system/42space-bot1-buy-rank-evidence.service
  cp -a ops/42space-bot1-buy-rank-evidence.timer /etc/systemd/system/42space-bot1-buy-rank-evidence.timer
  systemctl daemon-reload
  systemctl enable --now 42space-bot1-block-aware-calibration.timer
  systemctl enable --now 42space-bot1-buy-rank-evidence.timer
else
  systemctl daemon-reload
fi

systemctl restart 42space-event@42space.service
sleep 3
systemctl is-active --quiet 42space-event@42space.service

python3 - <<'PY'
import json
import os
import pathlib
import subprocess

def read_env(path):
    env = os.environ.copy()
    for raw in pathlib.Path(path).read_text(errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key] = value.strip().strip('"').strip("'")
    return env

env = read_env(os.environ["PROFILE_ENV"])
proc = subprocess.run(
    ["node", "src/event-sniper.js", "status", "--json"],
    cwd=os.environ["REMOTE_DIR"],
    env=env,
    capture_output=True,
    text=True,
    timeout=45,
)
if proc.returncode != 0:
    print(proc.stderr[-2000:])
    raise SystemExit(proc.returncode)
data = json.loads(proc.stdout)
wc = data.get("watchConfig", {})
summary = {
    "mode": data.get("mode"),
    "botName": wc.get("botName"),
    "eventDiscovery": wc.get("eventDiscovery"),
    "openBroadcastMode": wc.get("openBroadcastMode"),
    "openBroadcastDelayMs": wc.get("openBroadcastDelayMs"),
    "openBroadcastBlockAwareLeadMs": wc.get("openBroadcastBlockAwareLeadMs"),
    "openBroadcastBlockAwarePreTargetSendMs": wc.get("openBroadcastBlockAwarePreTargetSendMs"),
    "gasPriceGwei": wc.get("gasPriceGwei"),
    "autoSellStrategy": wc.get("autoSellStrategy"),
    "autoSellStopLossEnabled": wc.get("autoSellStopLossEnabled"),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
if summary["openBroadcastMode"] != "block_aware_20s":
    raise SystemExit("openBroadcastMode readback mismatch")
if summary["openBroadcastDelayMs"] != 19900:
    raise SystemExit("openBroadcastDelayMs readback mismatch")
if summary["openBroadcastBlockAwareLeadMs"] != 95:
    raise SystemExit("openBroadcastBlockAwareLeadMs readback mismatch")
PY

journalctl -u 42space-event@42space.service -n 120 --no-pager \
  | grep -E 'openBroadcastMode|open-broadcast-block-clock|error|warn|failed|异常|Unhandled' \
  | tail -40 || true
REMOTE_APPLY

echo "Bot1 block-aware activation complete."
