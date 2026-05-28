# Todo Outline

Current priority: move execution close to the fastest RPC path while preserving single-wallet, single-writer safety.

| Priority | Todo | Status |
| --- | --- | --- |
| 1 | [Multi Region Execution](./todos/05-multi-region-execution.md) | US West primary live; next proof is real-buy latency |
| 2 | [Execution And Risk](./todos/03-execution-risk.md) | broadcast-only buy lock plus auto-sell buy guard and chunked sell path active |
| 3 | [Discovery And Filtering](./todos/02-discovery-filtering.md) | Raw REST discovery, duration filter, speed-first fallback, decision log active |
| 4 | [Dashboard And Ops](./todos/04-dashboard-ops.md) | Full names, filter labels, funding states, PnL views active |
| 5 | [Operating Contract](./todos/01-operating-contract.md) | Server deploy proof current |

## Open Items Snapshot

- Multi-region: record real broadcast evidence after the next live buy from US West.
- Execution: verify the next real buy and first auto-sell path with the post-open scheduler, async receipt, operator preapproval, and chunked sell batches; surface failed broadcast reasons, add GTA and `$GENIUS` incident replays, add duplicate-prevention replay.
- Test tooling: make `event:bench` use the same REST fallback as production discovery.
- Discovery: monitor real `rest-discovery-poll` rows after the raw REST discovery fix.
- Dashboard: add simple source labels: Website, Chain, Both.
- Ops: keep using `scripts/health_check.sh` for quick status checks; add alerting only if manual checks become insufficient.

Update this file after code changes that change priorities or task status.
