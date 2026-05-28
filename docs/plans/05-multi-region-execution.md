# Multi Region Execution Plan

## Objective

Use the lowest-latency server as the execution owner without letting the same wallet run two independent buyers.

## Current State

- Primary: US West `47.251.26.212`.
- Standby: Hong Kong `47.83.23.65`.
- US West owns monitoring, signing, nonce, broadcasting, dashboard, and persisted state.
- Hong Kong must not run `42space-event-arm.service` while US West is the active writer.
- A future Hong Kong helper may broadcast the exact same pre-signed raw transaction, but it must not sign or submit a different transaction.

## Why

- US West measured materially faster to the paid broadcast path.
- The fastest safe shape is single writer plus multi-RPC fanout.
- Active-active signing with one private key can cause nonce races, duplicate buys, stale local state, and misleading dashboard records.

## Cutover Sequence

1. Sync code to US West. Done.
2. Install Node and dependencies. Done.
3. Sync production env without printing secrets. Done.
4. Run `npm run verify` on US West. Done.
5. Install systemd units on US West. Done.
6. Stop and disable Hong Kong services. Done.
7. Start and enable US West `42space-event-arm.service` and `42space-dashboard.service`. Done.
8. Confirm health, logs, wallet, and dashboard API. Done.
9. Keep Hong Kong as standby only. Active rule.

## Operating Rules

- Only one machine may run `event:arm` with the production private key.
- Dashboard can run on the active writer. Standby dashboard is optional and may be stale unless state replication exists.
- Secrets live in `/etc/42space/42space.env` on the active host.
- Do not copy secrets into Git, docs, logs, or terminal summaries.
- If US West is unhealthy, stop its `event:arm` before restarting Hong Kong `event:arm`.

## Future Upgrade

Implement a raw-transaction relay:

- Primary signs once.
- Primary sends signed raw tx to relay nodes.
- Relay nodes broadcast only that exact raw tx.
- All nodes report provider, first acceptance time, and errors back to the primary.
