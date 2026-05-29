# Plan Outline

Goal: run a 42 Event Market bot that detects eligible new markets, buys at open, tracks positions, and gives a simple operator view.

Active stage: [07 Single Install Multi Profile Runtime](./plans/07-single-install-multi-profile-runtime.md)

| Stage | Plan | Status |
| --- | --- | --- |
| 01 | [Operating Contract](./plans/01-operating-contract.md) | Running, keep verified |
| 02 | [Discovery And Filtering](./plans/02-discovery-filtering.md) | Active, speed-first fallback and decision log added |
| 03 | [Execution And Risk](./plans/03-execution-risk.md) | Running, buy-priority auto-sell guard and chunked sell path added |
| 04 | [Dashboard And Ops](./plans/04-dashboard-ops.md) | Running, three funding states and PnL views added |
| 05 | [Multi Region Execution](./plans/05-multi-region-execution.md) | Active, US West primary live and Hong Kong standby |
| 06 | [Multi Bot Profile Merge](./plans/06-multi-bot-profile-merge.md) | Complete, `MeiYanDong/42space` is the canonical codebase and contains the `42space-2` safety fixes |
| 07 | [Single Install Multi Profile Runtime](./plans/07-single-install-multi-profile-runtime.md) | Active, run both bot profiles from one `/opt/42space` program install with isolated env, data, services, and dashboards |

Update this file after code changes that alter scope, stage, or priority.
