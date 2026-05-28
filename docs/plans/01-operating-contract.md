# Operating Contract Plan

## Objective

Keep the bot deployable, observable, and recoverable without depending on the local Mac.

## Current Production Shape

- Current active host: `47.251.26.212`
- Standby host: `47.83.23.65`
- Production path on each host: `/opt/42space`
- Environment file on active host: `/etc/42space/42space.env`
- Dashboard: `http://47.251.26.212:4242/`
- Main services:
  - `42space-event-arm.service`
  - `42space-dashboard.service`
- Verification command: `npm run verify`

## Rules

- Server state is the source of truth for overnight running.
- Local Mac can be closed only after production service health and logs are checked.
- Only one host may run `42space-event-arm.service` with the production private key.
- US West is primary; Hong Kong is standby unless it is explicitly promoted.
- Secrets stay in server environment or local secret stores, never in Git.
- Git contains code, docs, templates, and non-secret defaults.
- Deployment proof should include commit, service status, and a recent log sample.

## Required Evidence After Ops Changes

- `git status --short`
- `npm run verify`
- `systemctl status 42space-event-arm.service`
- `systemctl status 42space-dashboard.service`
- Recent journal lines for both services

## Open Questions

- Whether to keep a separate lightweight deploy checklist under docs once server changes become frequent.
