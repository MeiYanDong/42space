# Operating Contract Todo

## Done

- [x] Deploy bot to `47.83.23.65`.
- [x] Run production from `/opt/42space`.
- [x] Use systemd services for bot and dashboard.
- [x] Keep RPC/private key/webhook outside Git.
- [x] Add `npm run verify`.
- [x] Record exact post-deploy verification commands.
- [x] 2026-05-27 deploy verification: local verify passed, server verify passed, both systemd services active, dashboard API healthy, event-arm logs checked.
- [x] Add one-command deploy/check script: `scripts/deploy_check.sh`.
- [x] Add non-restarting health-check-only script: `scripts/health_check.sh`.
- [x] Add US West host `47.251.26.212` as target primary and record single-writer rule.
- [x] 2026-05-27 cutover: US West `42space-event-arm.service` and `42space-dashboard.service` enabled and active; Hong Kong services disabled and inactive.
- [x] 2026-05-27 US West dashboard public health returned `200` at `http://47.251.26.212:4242/`.
- [x] Update deploy and health scripts to default to US West on SSH port `2222`.

## Next

- [ ] Keep using US West as active host and verify next real buy from its logs.
- [ ] Add alerting only if manual health checks become insufficient.

## Post-Deploy Verification Commands

```bash
npm run verify
rsync -az src public docs ops scripts package.json package-lock.json README.md AGENTS.md .env.example root@47.83.23.65:/opt/42space/
ssh root@47.83.23.65 'cd /opt/42space && npm run verify'
ssh root@47.83.23.65 'systemctl restart 42space-event-arm.service 42space-dashboard.service && sleep 3 && systemctl is-active 42space-event-arm.service 42space-dashboard.service'
ssh root@47.83.23.65 'curl -fsS http://127.0.0.1:4242/api/overview'
ssh root@47.83.23.65 'journalctl -u 42space-event-arm.service -n 100 --no-pager'
```

Use the checked-in wrapper for normal production deploys:

```bash
scripts/deploy_check.sh
```

Use the non-restarting wrapper for quick health checks:

```bash
scripts/health_check.sh
```

US West SSH:

```bash
ssh -p 2222 root@47.251.26.212
```

Never run `42space-event-arm.service` on Hong Kong and US West at the same time.

Active dashboard:

```text
http://47.251.26.212:4242/
```

## Update Rule

Update this file after server, deploy, secret, service, or verification changes.
