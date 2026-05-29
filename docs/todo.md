# Todo Outline

Current priority: collapse the server runtime to one `/opt/42space` program install while keeping `42space` production and `42space-2` A/B testing isolated as separate bot profiles.

| Priority | Todo | Status |
| --- | --- | --- |
| 1 | [Single Install Multi Profile Runtime](./todos/07-single-install-multi-profile-runtime.md) | Active; move both bots to one code install with templated systemd services |
| 2 | [Multi Bot Profile Merge](./todos/06-multi-bot-profile-merge.md) | Complete; canonical repo migration and rollout are done |
| 3 | [Multi Region Execution](./todos/05-multi-region-execution.md) | US West primary live; next proof is real-buy latency |
| 4 | [Execution And Risk](./todos/03-execution-risk.md) | broadcast-only buy lock plus auto-sell buy guard and chunked sell path active |
| 5 | [Discovery And Filtering](./todos/02-discovery-filtering.md) | Raw REST discovery, duration filter, speed-first fallback, decision log active |
| 6 | [Dashboard And Ops](./todos/04-dashboard-ops.md) | Full names, filter labels, funding states, PnL views active |
| 7 | [Operating Contract](./todos/01-operating-contract.md) | Server deploy proof current |

## Open Items Snapshot

- Runtime layout: migrate the server from `/opt/42space + /opt/42space-2` to one `/opt/42space` code install with `42space` and `42space-2` profile env files.
- Multi-region: record real broadcast evidence after the next live buy from US West.
- Execution: verify the next real buy and first auto-sell path with the post-open scheduler, async receipt, operator preapproval, chunked sell batches, and migrated circuit breaker; surface failed broadcast reasons, add GTA and `$GENIUS` incident replays, add duplicate-prevention replay.
- Test tooling: make `event:bench` use the same REST fallback as production discovery.
- Discovery: monitor real `rest-discovery-poll` rows after the raw REST discovery fix.
- Dashboard: add simple source labels: Website, Chain, Both.
- Ops: keep using `scripts/health_check.sh` for quick status checks; add alerting only if manual checks become insufficient.

Update this file after code changes that change priorities or task status.
