# Multi Bot Profile Merge Todo

## Phase 1: Documentation And Diff Audit

- [x] Update `docs/plan.md` so the active stage is Multi Bot Profile Merge.
- [x] Add `docs/plans/06-multi-bot-profile-merge.md` with the accepted requirements, isolation rules, and migration contract.
- [x] Update `docs/todo.md` so the active priority is Multi Bot Profile Merge.
- [x] Add this executable checklist in `docs/todos/06-multi-bot-profile-merge.md`.
- [x] Compare `/Users/myandong/Projects/42space` and `/Users/myandong/Projects/42space-2`.
- [x] Identify `42space-2` fixes missing from canonical `42space`.
- [x] Confirm no unrelated dirty files are part of this migration.

## Phase 2: Canonical Code Migration

- [x] Migrate runtime config file support into canonical `42space`.
- [x] Preserve canonical production defaults: bot name `42space`, dashboard port `4242`, systemd worker `42space-event-arm.service`, production gas default.
- [x] Migrate dashboard runtime config APIs and frontend controls.
- [x] Extend runtime config so dashboard can edit `GAS_PRICE_GWEI` per profile.
- [x] Extend runtime config so dashboard can edit profile-local auto-sell ladder and stop-loss parameters.
- [x] Migrate auto-sell circuit breaker state file and config validation.
- [x] Migrate per-position failure cooldown and global circuit open behavior.
- [x] Migrate auto-sell BNB gas guard and min-reserve checks.
- [x] Migrate compact auto-sell error messages and Feishu cooldown/dedupe.
- [x] Migrate sell amount rounding for direct `amountOt` sells.
- [x] Migrate sub-tick sell amount rejection.
- [x] Export and self-test `roundDownSellAmount`.
- [x] Migrate dashboard `fills.jsonl` tail-read hotfix.
- [x] Migrate auto-sell eligible-market tail-read hotfix.
- [x] Preserve position-state fallback for auto-sell eligibility after tail reads.
- [x] Keep `42space` and `42space-2` profile data files, env files, ports, services, and webhooks isolated.

## Phase 3: Local Verification

- [x] Run `npm run verify` in `/Users/myandong/Projects/42space`.
- [x] Confirm event self-test covers circuit breaker, cooldown, tick rounding, and tail-read eligibility.
- [x] Confirm dashboard server syntax check passes with runtime config changes.
- [x] Confirm no private key, RPC key, Feishu webhook, or wallet secret was committed.
- [x] Review `git diff` to ensure changes are scoped to docs, config, dashboard, event sniper, and shared sell helpers.

## Phase 4: Git Hygiene

- [x] Commit canonical migration changes to `MeiYanDong/42space`.
- [x] Push `main` to `origin`.
- [x] Leave unrelated dirty files untouched.

## Phase 5: A/B Bot Rollout

- [x] Deploy canonical `42space` code to the `42space-2` runtime only.
- [x] Preserve `/etc/42space-2/42space.env`.
- [x] Preserve `/opt/42space-2/data`.
- [x] Preserve dashboard port `4243`.
- [x] Preserve `42space-2-event-arm.service` and `42space-2-dashboard.service`.
- [x] Verify `/api/overview` on port `4243` returns `ok: true`.
- [x] Verify production `42space` services remain active.

## Phase 6: Production Rollout Boundary

- [x] Ask for explicit approval before deploying to production `42space`.
- [x] Preserve `/etc/42space/42space.env`.
- [x] Preserve `/opt/42space/data`.
- [x] Preserve dashboard port `4242`.
- [x] Preserve `42space-event-arm.service` and `42space-dashboard.service`.
- [x] Verify production health after deployment.

## Update Rule

After each completed implementation step, change the matching checkbox from `[ ]` to `[x]` in this file. Do not mark server rollout boxes complete unless the deployment and health checks actually happened.
