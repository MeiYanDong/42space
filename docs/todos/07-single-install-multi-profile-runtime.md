# Single Install Multi Profile Runtime Todo

## Phase 1: Documentation And Code Guard

- [x] Document the single-install multi-profile target model.
- [x] Document the isolation contract and rollback rule.
- [x] Add profile-local `DASHBOARD_ACTIONS_FILE` support.
- [x] Run local verification.
- [x] Confirm no secret values were committed.

## Phase 2: Server Profile Layout

- [x] Deploy canonical code to `/opt/42space`.
- [x] Create `/etc/42space/profiles`.
- [x] Create `/etc/42space/profiles/42space.env` from the current production env.
- [x] Create `/etc/42space/profiles/42space-2.env` from the current A/B env.
- [x] Convert profile data paths to absolute profile-local paths.
- [x] Document `MARKET_FOLLOW_FILE` as profile-local state for follow-controlled buy gating.
- [x] Preserve production data under `/opt/42space/data/42space`.
- [x] Preserve A/B data under `/opt/42space/data/42space-2`.

## Phase 3: Templated Services

- [x] Install `42space-event@.service`.
- [x] Install `42space-dashboard@.service`.
- [x] Start `42space-dashboard@42space.service`.
- [x] Start `42space-event@42space.service`.
- [x] Start `42space-dashboard@42space-2.service`.
- [x] Start `42space-event@42space-2.service`.

## Phase 4: Legacy Retirement

- [x] Stop and disable `42space-dashboard.service`.
- [x] Stop and disable `42space-event-arm.service`.
- [x] Stop and disable `42space-2-dashboard.service`.
- [x] Stop and disable `42space-2-event-arm.service`.
- [x] Confirm no event worker is still running from `/opt/42space-2`.

## Phase 5: Verification

- [x] Run `npm run verify` on the server from `/opt/42space`.
- [x] Verify `42space-dashboard@42space.service` and `42space-event@42space.service` are active.
- [x] Verify `42space-dashboard@42space-2.service` and `42space-event@42space-2.service` are active.
- [x] Verify `http://47.251.26.212:4242/api/overview` returns `ok: true`.
- [x] Verify `http://47.251.26.212:4243/api/overview` returns `ok: true`.
- [x] Confirm dashboard processes and worker processes all use `/opt/42space` as cwd.

## Update Rule

After each completed implementation step, change the matching checkbox from `[ ]` to `[x]`. Do not mark a server step complete until the server state has actually been verified.
