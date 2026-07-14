# 42Space 自动化：先讲风险，再讲系统

这是一版“风险与证据型” README。它适合先关注资金安全、可审计性和为什么不能盲目自动交易的人。

## 第一原则

这个项目可以发真实链上交易，所以第一原则是：

> 自动化可以提高执行稳定性，但不能消除市场风险、合约风险、Gas 风险、RPC 风险、nonce 风险和策略判断风险。

因此本项目的核心不是“自动赚钱”，而是：

- 清楚知道什么时候发现市场；
- 清楚知道为什么买或不买；
- 清楚知道交易什么时候发出去；
- 清楚知道 receipt 成功还是失败；
- 清楚知道 Gas 花了多少；
- 清楚知道后续卖出是否符合规则；
- 出问题后能复盘，而不是靠猜。

## 42Space 是什么

42Space 是事件结果交易市场。一个 market 会问一个问题，并列出多个 outcomes。用户可以买某个 outcome 的链上凭证，也就是 `Outcome Token`。

例子：

```text
问题：某个币种 FDV 会落在哪个区间？
结果：$50M-$100M、$100M-$150M、$150M-$300M...
```

买某个结果，不等于这个结果一定发生。它只是给你一个链上头寸。结果、成交顺序、卖出价格、Gas 成本都可能影响最终盈亏。

本项目不是 42Space 官方服务，也不是收益承诺。

## 为什么需要自动化

人工操作有几个天然问题：

- 新市场发现不稳定；
- 开盘窗口很短；
- 手动检查资金和授权很慢；
- 交易是否发出、是否上链、为什么失败，经常事后说不清；
- 多钱包/多策略容易混状态；
- 手动卖出可能和开盘买入争 nonce；
- 告警太多会让人麻木，告警太少又会漏事故。

这个项目的目标是给这些问题建立边界和证据。

## 证据链设计

每个关键动作都应该留下证据。

| 证据 | 说明 |
| --- | --- |
| Market discovery | 市场从哪里被发现，WSS、REST、chain replay 还是 feed。 |
| Market decisions | 为什么展示、通知、关注、买入、跳过或失败。 |
| Fills | 买入和卖出的事实记录。 |
| Receipt | 链上交易成功/失败、区块、Gas。 |
| Gas ledger | 每个 profile 的交易成本。 |
| Buy-rank evidence | 同市场内我们的买入排序。 |
| Dashboard action log | 人在 Dashboard 做过什么。 |
| Feishu alerts | 关键风险和失败提醒。 |

如果一个系统只会自动买，但不能解释为什么买、为什么没买、为什么失败，那就不适合控制真实资金。

## 系统框架

```text
发现：先知道市场出现了
  -> 判断：再决定展示、通知、关注、买入或跳过
  -> 执行：资金、授权、预签、广播、receipt
  -> 风控：自动卖出、热区保护、nonce 保护
  -> 证据：fills、decisions、Gas、rank、Dashboard、Feishu
```

## 风险边界

### 资金边界

- 使用小额热钱包；
- 不使用主钱包；
- BUSDT 和 BNB 要按 profile 单独准备；
- Router allowance 需要提前检查；
- 资金不足时不能静默进入危险状态。

### 秘密边界

- 私钥不进 Git；
- RPC key 不进 Git；
- Feishu webhook 不进 Git；
- 报告和日志不打印 secrets；
- profile env 在服务器维护。

### Nonce 边界

同一个钱包不能被两个独立 signer 同时控制。

项目采用多 profile 隔离：

- 独立私钥；
- 独立 RPC；
- 独立 state；
- 独立 fills；
- 独立 auto-sell；
- 独立 dashboard action log。

### 交易时间边界

- 不默认开盘前广播；
- 开盘窗口过期后不继续盲目买；
- hot window 里避免慢操作；
- 手动卖出不能破坏买入热区；
- 自动卖出和买入共享 transaction lock。

### 决策边界

- 展示不等于买；
- 通知不等于买；
- event intelligence 不在热路径里做同步买入决策；
- planned buy 才能明确覆盖全局规则；
- profile 之间不互相继承买入意图。

## 多 profile 为什么是风险控制

生产环境使用一份代码，多套 profile。

共享代码是为了减少版本漂移；隔离状态是为了降低事故半径。

| Profile | 风险隔离意义 |
| --- | --- |
| Bot1 | 主生产和 planned-buy 验证不被实验 profile 干扰。 |
| Bot2 | A/B focus-buy 独立记录和独立资金。 |
| Bot3 | exact-score 逻辑独立，不继承 Bot2 的 Meme/Binance 买入意图。 |
| Bot4 | daily-template 逻辑独立，避免模板策略污染普通事件。 |
| Bot5 | Bot2-like staging 用独立钱包验证，不共享 Bot2 nonce。 |

## 核心模块

| 模块 | 风险视角 |
| --- | --- |
| `src/event-sniper.js` | 主执行路径，必须控制资金、时间、nonce 和 receipt。 |
| `src/event-strategy.js` | 决定展示和买入边界，避免误买。 |
| `src/event-intel.js` | 只读情报，不能阻塞交易。 |
| `src/event-premium-watch.js` | 只读观察开盘成本，不签名不广播。 |
| `src/dashboard-server.js` | 给人操作，但必须保护买入热区。 |
| `scripts/gas-ledger-backfill.js` | 补齐历史 Gas 成本，支持 PnL 复盘。 |
| `scripts/bot3-buy-rank-evidence.js` | 只读排名证据，不接触私钥。 |

## 安全上手

```bash
npm install
cp .env.example .env
npm run verify
npm run event:scan
npm run event:plan
npm run event:doctor -- --wallet 0x...
```

默认 dry-run：

```text
DRY_RUN=1
EXECUTE=0
PRIVATE_KEY=
```

## 真实交易门槛

真实交易必须显式打开：

```text
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

并且至少完成：

- `npm run verify`;
- `npm run event:doctor`;
- `npm run event:preflight`;
- `npm run event:approve`;
- Dashboard 可读；
- Feishu 告警可用；
- profile isolation 确认；
- 自动卖出策略确认。

## 文档入口

- 总览：[docs/plan.md](../plan.md)
- 当前事实：[docs/todo.md](../todo.md)
- 执行风险：[docs/plans/03-execution-risk.md](../plans/03-execution-risk.md)
- 多 profile：[docs/plans/07-single-install-multi-profile-runtime.md](../plans/07-single-install-multi-profile-runtime.md)
- Dashboard：[docs/plans/04-dashboard-ops.md](../plans/04-dashboard-ops.md)
- 情报 sidecar：[docs/plans/08-event-intelligence.md](../plans/08-event-intelligence.md)

## 最后一句

这个项目的价值不只是“能自动下单”，而是让自动下单这件事有边界、有证据、有隔离、有复盘。
