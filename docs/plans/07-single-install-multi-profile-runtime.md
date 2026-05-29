# Single Install Multi Profile Runtime Plan

## Objective

Run `42space` and `42space-2` as two independent bot profiles from one installed program directory, `/opt/42space`.

This is the runtime step after the code merge. The code source of truth is `MeiYanDong/42space`; `42space-2` remains an A/B testing bot, but it should no longer require a separate server code tree.

## Target Model

```text
/opt/42space
  src/
  public/
  docs/
  package.json

/etc/42space/profiles/42space.env
/etc/42space/profiles/42space-2.env

/opt/42space/data/42space/
/opt/42space/data/42space-2/

42space-event@42space.service
42space-event@42space-2.service
42space-dashboard@42space.service
42space-dashboard@42space-2.service
```

Each bot runs in its own process with its own environment file and data directory. The shared part is only the program code and static UI assets.

## Isolation Contract

The two profiles must not share:

- private key;
- wallet address;
- RPC HTTP or WSS endpoint;
- Feishu webhook;
- dashboard port;
- runtime config file;
- fills, market decisions, seen markets, auto-sell state, auto-sell circuit state, or dashboard action log;
- systemd service instance.

The two profiles may share:

- `/opt/42space/src`;
- `/opt/42space/public`;
- `package.json` and installed dependencies;
- dashboard UI code.

## Why This Shape

The previous migration made `MeiYanDong/42space` the canonical codebase, but the server still had two code directories: `/opt/42space` and `/opt/42space-2`.

That reduced code fork risk, but UI/code updates still had to be synced to two directories.

This migration makes updates simpler:

1. deploy code once to `/opt/42space`;
2. restart the affected profile instances;
3. both dashboards get the same UI code while keeping profile-local data and config.

It intentionally does not run both wallets inside one Node process. Separate processes keep nonce locks, crashes, CPU pressure, dashboard calls, and auto-sell circuit breakers easier to isolate and audit.

## Runtime Profile Rules

Each profile env must set:

- `BOT_NAME`;
- `BOT_SYSTEMD_SERVICE`;
- `DASHBOARD_PORT`;
- `RUNTIME_CONFIG_FILE`;
- `MARKET_FOLLOW_FILE`;
- `STATE_FILE`;
- `FILLS_FILE`;
- `MARKET_DECISIONS_FILE`;
- `AUTO_SELL_STATE_FILE`;
- `AUTO_SELL_POSITION_STATE_FILE`;
- `AUTO_SELL_CIRCUIT_STATE_FILE`;
- `DASHBOARD_ACTIONS_FILE`.

All data file values should be absolute paths under the profile data directory, for example:

```text
RUNTIME_CONFIG_FILE=/opt/42space/data/42space-2/runtime-config.json
MARKET_FOLLOW_FILE=/opt/42space/data/42space-2/market-follow.json
FILLS_FILE=/opt/42space/data/42space-2/fills.jsonl
DASHBOARD_ACTIONS_FILE=/opt/42space/data/42space-2/dashboard-actions.jsonl
```

Absolute paths are required because both profiles use the same working directory.

If a live profile may be temporarily unfunded, set `ARM_WAIT_FOR_FUNDING=1` for that profile. Otherwise `event:arm` exits on funding preflight failure and systemd will restart it repeatedly.

## Service Rules

Use templated systemd services:

- `42space-event@.service`
- `42space-dashboard@.service`

Instance `%i` maps to `/etc/42space/profiles/%i.env`.

The dashboard instance must set `BOT_SYSTEMD_SERVICE=42space-event@%i.service` so dashboard runtime-config changes restart only the matching event worker.

## Migration Steps

1. Add the profile runtime documentation and profile-local dashboard action file support.
2. Verify the canonical repo locally.
3. Deploy canonical code to `/opt/42space`.
4. Create `/etc/42space/profiles`.
5. Copy existing production env to `/etc/42space/profiles/42space.env`.
6. Copy existing A/B env to `/etc/42space/profiles/42space-2.env`.
7. Add absolute profile-local data paths to both env files without printing secrets.
8. Move or copy `/opt/42space-2/data` into `/opt/42space/data/42space-2`.
9. Keep `/opt/42space/data` production files, then normalize production paths to `/opt/42space/data/42space`.
10. Install templated systemd units.
11. Start `42space-dashboard@42space`, `42space-event@42space`, `42space-dashboard@42space-2`, and `42space-event@42space-2`.
12. Stop and disable legacy `42space-*` and `42space-2-*` services only after the new instances are healthy.
13. Verify dashboards on ports `4242` and `4243`.
14. Verify only the new templated event workers are running.

## Rollback

If either profile fails after migration:

1. stop the failed templated profile instance;
2. restart the matching legacy service while its old env and data directory are still present;
3. inspect journal logs before retrying.

Do not run the same wallet in both legacy and templated event workers at the same time.

## Definition Of Done

- `/opt/42space` is the only active code install.
- `42space` and `42space-2` both run from templated services.
- `42space-2` no longer has an active worker or dashboard process from `/opt/42space-2`.
- `http://47.251.26.212:4242/api/overview` returns `ok: true`.
- `http://47.251.26.212:4243/api/overview` returns `ok: true`.
- Process cwd for both dashboards and both workers is `/opt/42space`.
- Profile data is under `/opt/42space/data/42space` and `/opt/42space/data/42space-2`.
- No secrets are committed or printed.
