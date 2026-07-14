# 42space-2 Agent Handoff

## Objective

Create a separate experimental copy of the current `42space` bot named `42space-2`.

`42space` must keep running as the current production bot. `42space-2` must run in parallel on the same US West server, but with separate wallet, RPC, Feishu webhook, GitHub repository, systemd services, dashboard port, environment file, and data directory.

## User Decisions

- Project name: `42space-2`.
- Strategy: same as current `42space`.
- Auto-sell: same as current `42space`.
- Feishu: separate webhook, not shared with `42space`.
- GitHub: separate repository.
- Server: same active US West server, `47.251.26.212`.
- Current `42space` must not be stopped or modified except for read-only verification.

## Current Production Baseline

Existing production project:

- Local source: `/Users/myandong/Projects/42space`
- Server path: `/opt/42space`
- Server env: `/etc/42space/42space.env`
- Dashboard: `http://47.251.26.212:4242/`
- Services:
  - `42space-event-arm.service`
  - `42space-dashboard.service`

Current strategy baseline:

- Buy 3 outcomes.
- Buy the first outcomes by display/token order.
- Stake per outcome: `6U`.
- Normal max cost per market: `18U`.
- Buy path must start within `EVENT_OPEN_WINDOW_SECONDS=20`.
- Exclude Price markets.
- Buy only non-Price Event Markets with duration at least `48h`.
- Use speed-first fallback when odds are missing.
- Pre-sign in hot window.
- Do not pre-open broadcast by default: `ALLOW_PREOPEN_BROADCAST=0`.
- Current anti-snipe entry time: `OPEN_BROADCAST_DELAY_MS=19000` (`T+19s`).
- Do not wait for receipt in buy lock: `WAIT_FOR_RECEIPT=0`, `ASYNC_RECEIPT_WATCH=1`.
- Current Bot2 auto-sell strategy: `open_timed_exit`, sell 100% at market-open `T+25s`; fast randomized open-exit is enabled to pre-sign the sell batch after buy receipt and broadcast inside `T+24.5s` to `T+26.0s`; the old `ladder` strategy remains available for rollback.
- Auto stop-loss: one outcome down 10%, sell that outcome fully.

## Required Isolation

Do not reuse any of these from `42space`:

- Private key.
- Wallet address.
- RPC HTTP endpoint.
- RPC WSS endpoint.
- Feishu webhook.
- Server env file.
- Data directory.
- systemd service names.
- Dashboard port.
- GitHub repository.

Use this mapping:

| Item | `42space` | `42space-2` |
| --- | --- | --- |
| Local path | `/Users/myandong/Projects/42space` | `/Users/myandong/Projects/42space-2` |
| Server path | `/opt/42space` | `/opt/42space-2` |
| Env file | `/etc/42space/42space.env` | `/etc/42space-2/42space.env` |
| Dashboard port | `4242` | `4243` |
| Dashboard URL | `http://47.251.26.212:4242/` | `http://47.251.26.212:4243/` |
| Event service | `42space-event-arm.service` | `42space-2-event-arm.service` |
| Dashboard service | `42space-dashboard.service` | `42space-2-dashboard.service` |
| GitHub repo | current repo | new `42space-2` repo |

## Local Copy Plan

1. Confirm current repo state:

```bash
cd /Users/myandong/Projects/42space
git status --short
npm run verify
```

2. Create the local copy without copying runtime state:

```bash
rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude .env.local \
  --exclude output \
  /Users/myandong/Projects/42space/ \
  /Users/myandong/Projects/42space-2/
```

3. Initialize separate Git:

```bash
cd /Users/myandong/Projects/42space-2
git init
npm install
npm run verify
```

4. Create a separate GitHub repo. Do not push secrets. Visibility should be confirmed before creation; if not confirmed, start private.

## Server Deployment Plan

1. Create server directories:

```bash
ssh -p 2222 root@47.251.26.212 'mkdir -p /opt/42space-2 /etc/42space-2'
```

2. Sync code to `/opt/42space-2`:

```bash
rsync -az \
  -e "ssh -p 2222 -o BatchMode=yes -o ConnectTimeout=10" \
  src public docs ops scripts package.json package-lock.json README.md AGENTS.md .env.example \
  root@47.251.26.212:/opt/42space-2/
```

3. Create `/etc/42space-2/42space.env` from `.env.example`, then set new project values. Do not print the file after secrets are added.

Required differences from `42space`:

```bash
DASHBOARD_PORT=4243
PRIVATE_KEY=<42space-2 private key>
WALLET_ADDRESS=<42space-2 wallet>
BSC_RPC_URL=<42space-2 HTTP RPC>
BSC_WS_URL=<42space-2 WSS RPC>
FEISHU_WEBHOOK=<42space-2 Feishu webhook>
STATE_FILE=data/seen-markets.json
FILLS_FILE=data/fills.jsonl
MARKET_DECISIONS_FILE=data/market-decisions.jsonl
AUTO_SELL_STATE_FILE=data/auto-sell-seen.json
AUTO_SELL_POSITION_STATE_FILE=data/auto-sell-positions.json
```

Keep strategy values aligned with current production:

```bash
STAKE_PER_OUTCOME_USDT=6
EVENT_OUTCOME_COUNT=3
EVENT_OUTCOME_SELECTION=first
MAX_MARKET_STAKE_USDT=18
MAX_BATCH_STAKE_USDT=18
EVENT_OPEN_WINDOW_SECONDS=20
MARKET_CATEGORY_BLOCKLIST=Price
MARKET_TAG_BLOCKLIST=8 hour,automated
MIN_EVENT_DURATION_HOURS=48
AUTO_SELL_ENABLED=1
AUTO_SELL_STRATEGY=open_timed_exit
AUTO_SELL_START_DELAY_SECONDS=10
AUTO_SELL_INTERVAL_SECONDS=10
AUTO_SELL_CHUNK_PERCENT=10
AUTO_SELL_LADDER_PROFIT_PERCENT=100
AUTO_SELL_OPEN_EXIT_DELAY_SECONDS=25
AUTO_SELL_OPEN_EXIT_PERCENT=100
AUTO_SELL_FAST_OPEN_EXIT_ENABLED=1
AUTO_SELL_FAST_OPEN_EXIT_MIN_DELAY_MS=24500
AUTO_SELL_FAST_OPEN_EXIT_MAX_DELAY_MS=26000
AUTO_SELL_STOP_LOSS_ENABLED=1
AUTO_SELL_STOP_LOSS_PERCENT=10
AUTO_SELL_STOP_LOSS_SELL_PERCENT=100
ALLOW_PREOPEN_BROADCAST=0
OPEN_BROADCAST_DELAY_MS=19000
WAIT_FOR_RECEIPT=0
ASYNC_RECEIPT_WATCH=1
```

4. Install two new systemd services. They must use `/opt/42space-2` as working directory and `/etc/42space-2/42space.env` as environment file.

Service names:

```bash
42space-2-event-arm.service
42space-2-dashboard.service
```

5. First start in dry-run mode unless the user explicitly confirms real execution:

```bash
DRY_RUN=1
EXECUTE=0
```

Then:

```bash
systemctl daemon-reload
systemctl enable --now 42space-2-dashboard.service
systemctl enable --now 42space-2-event-arm.service
```

6. Verify:

```bash
ssh -p 2222 root@47.251.26.212 'cd /opt/42space-2 && npm run verify'
ssh -p 2222 root@47.251.26.212 'systemctl is-active 42space-2-event-arm.service 42space-2-dashboard.service'
curl -fsS http://47.251.26.212:4243/api/overview
```

7. Before real mode:

```bash
cd /opt/42space-2
npm run event:preflight
npm run event:approve
npm run event:presign-test
npm run event:due-test
npm run event:deadline-test
```

8. Switch to live only after user confirms new wallet is funded with BUSDT and BNB:

```bash
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

Restart both services after env changes.

## Safety Checks

Before enabling live execution:

- Confirm `42space` services are still active.
- Confirm `42space-2` uses a different wallet from `42space`.
- Confirm `42space-2` dashboard is on port `4243`.
- Confirm `42space-2` logs write under `/opt/42space-2/data`.
- Confirm Feishu messages clearly identify `42space-2`.
- Confirm no secret values were committed to GitHub.
- Confirm `event:approve` succeeded for the new wallet.
- Confirm `event:funding` says at least one complete market is buyable.

## Known Risk

If both projects use the same strategy, they may both buy the same eligible market. This is expected and does not create nonce conflict because wallets are separate, but it doubles exposure to the same event.

If the same private key is accidentally reused, stop `42space-2-event-arm.service` immediately. Two independent signers with one wallet can create nonce races and duplicate gas burn.

## Definition Of Done

- Local `/Users/myandong/Projects/42space-2` exists and passes `npm run verify`.
- Separate GitHub repo exists and contains no secrets.
- Server `/opt/42space-2` exists.
- `/etc/42space-2/42space.env` exists with new wallet, new RPC, new Feishu webhook, and `DASHBOARD_PORT=4243`.
- `42space-2-dashboard.service` is active.
- `42space-2-event-arm.service` is active.
- `http://47.251.26.212:4243/api/overview` returns `ok: true`.
- Current `42space` on port `4242` remains healthy.
- Live mode is enabled only after explicit user confirmation and funding verification.
