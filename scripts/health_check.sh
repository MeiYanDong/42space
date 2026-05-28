#!/usr/bin/env bash
set -euo pipefail

HOST="${SPACE42_HOST:-root@47.251.26.212}"
SSH_PORT="${SPACE42_SSH_PORT:-2222}"
APP_DIR="${SPACE42_APP_DIR:-/opt/42space}"
DASHBOARD_URL="${SPACE42_DASHBOARD_URL:-http://127.0.0.1:4242/api/overview}"
SINCE="${SPACE42_LOG_SINCE:-30 min ago}"

ssh -p "$SSH_PORT" "$HOST" "APP_DIR='$APP_DIR' DASHBOARD_URL='$DASHBOARD_URL' SINCE='$SINCE' bash -se" <<'REMOTE'
set -euo pipefail

cd "$APP_DIR"

systemctl is-active --quiet 42space-event-arm.service
systemctl is-active --quiet 42space-dashboard.service

node - <<'NODE'
const http = require("http");
const url = process.env.DASHBOARD_URL;

http.get(url, (res) => {
  let body = "";
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.error(JSON.stringify({ ok: false, statusCode: res.statusCode }));
      process.exit(1);
    }
    const data = JSON.parse(body);
    if (!data.ok) {
      console.error(JSON.stringify({ ok: false, message: data.message || "dashboard not ok" }));
      process.exit(1);
    }
    const summary = {
      ok: true,
      updatedAt: data.updatedAt,
      bot: data.bot,
      wallet: data.wallet,
      next: {
        count: data.next?.count ?? 0,
        first: data.next?.first ?? null
      },
      holdings: {
        count: data.holdings?.count ?? 0
      },
      settings: data.settings
    };
    console.log(JSON.stringify(summary, null, 2));
  });
}).on("error", (error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exit(1);
});
NODE

alerts="$(journalctl -u 42space-event-arm.service --since "$SINCE" --no-pager \
  | egrep -i 'fatal|unhandled|(^|[ {,])error|fail|revert' \
  | egrep -vi 'event-arm-waiting-for-funds|Watch preflight failed|waiting-for-funds' || true)"
if [ -n "$alerts" ]; then
  echo "$alerts"
  exit 2
fi

echo "services active; dashboard ok; no fatal/error/fail/revert logs since $SINCE"
REMOTE
