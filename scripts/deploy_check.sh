#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@47.251.26.212}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:-2222}"
REMOTE_DIR="${REMOTE_DIR:-/opt/42space}"

cd "$ROOT_DIR"

npm run verify

rsync -az \
  -e "ssh -p ${REMOTE_SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10" \
  src public docs ops scripts package.json package-lock.json README.md AGENTS.md .env.example \
  "${REMOTE_HOST}:${REMOTE_DIR}/"

ssh -p "$REMOTE_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
  "cd '$REMOTE_DIR' && npm run verify"

ssh -p "$REMOTE_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
  "systemctl restart 42space-event-arm.service 42space-dashboard.service && sleep 3 && systemctl is-active 42space-event-arm.service 42space-dashboard.service"

ssh -p "$REMOTE_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
  "curl -fsS http://127.0.0.1:4242/api/overview >/dev/null"

ssh -p "$REMOTE_SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
  "journalctl -u 42space-event-arm.service -n 100 --no-pager | grep -Ei 'error|warn|failed|异常|Unhandled' | tail -30 || true"
