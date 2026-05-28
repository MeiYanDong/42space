# Multi Region Execution Todo

## Done

- [x] Benchmark Hong Kong and US West RPC paths.
- [x] Decide that US West should become primary because paid RPC latency is lower there.
- [x] Define the single-writer rule: one wallet, one active `event:arm`.
- [x] Sync current code to US West `/opt/42space`.
- [x] Install Node and dependencies on US West.
- [x] Sync `/etc/42space/42space.env` to US West without printing secrets.
- [x] Run `npm run verify` on US West.
- [x] Install US West systemd units.
- [x] Stop and disable Hong Kong `42space-event-arm.service` and `42space-dashboard.service`.
- [x] Start and enable US West `42space-event-arm.service` and `42space-dashboard.service`.
- [x] Verify US West dashboard API and logs.
- [x] Verify public dashboard returns `200` at `http://47.251.26.212:4242/`.
- [x] 2026-05-27 `scripts/health_check.sh` passed against US West: services active, dashboard ok, no fatal/error/fail/revert logs in the last 30 minutes.
- [x] 2026-05-27 US West read-only latency pressure test passed: Ankr sequential `eth_blockNumber` p50 `28.8ms`, p95 `46.5ms`; Chainstack p50 `84ms`, p95 `140.7ms`; race won by Ankr `119/120`, first-response p50 `17.1ms`, p95 `48.7ms`.
- [x] 2026-05-27 US West HTTP pressure check passed: 42 REST markets p50 `203.5ms`, p95 `328.7ms`; local dashboard p50 `1.1ms`.
- [x] 2026-05-27 post-test health passed: services active, production decision log had zero dry-run/catchup artifacts.

## Next

- [ ] Record next real broadcast acceptance latency from US West.
- [ ] Build raw-tx relay only after the primary migration is stable.

## Rollback

- Stop US West `42space-event-arm.service`.
- Start Hong Kong `42space-event-arm.service`.
- Keep dashboard pointed at the active writer.

## Update Rule

Update this file after server role, cutover, relay, systemd, or verification changes.
