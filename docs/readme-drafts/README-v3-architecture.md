# 42Space Bot 架构地图

这是一版“系统架构型” README。它适合工程师和接手维护者。

## 0. 背景

42Space 是事件市场。一个 market 由一个问题和多个 possible outcomes 组成。用户可以买某个 outcome 的 `Outcome Token`，在结算前卖出或持有到结算。

本仓库实现的是 42 Event Market 自动化系统，目标是：

> 在不混淆 profile 状态、不泄露秘密、不阻塞热交易路径的前提下，完成市场发现、策略判断、开盘执行、卖出管理、证据记录和 operator view。

## 1. 总体架构

```text
                +------------------+
                | 42 REST          |
                +------------------+
                         |
                +------------------+
                | BNB Chain logs   |
                +------------------+
                         |
                         v
              +----------------------+
              | Discovery layer      |
              +----------------------+
                         |
                         v
              +----------------------+
              | Strategy / Intel     |
              +----------------------+
                         |
                         v
              +----------------------+
              | Execution runtime    |
              +----------------------+
                         |
                         v
              +----------------------+
              | Auto-sell / Evidence |
              +----------------------+
                         |
                         v
              +----------------------+
              | Dashboard / Feishu   |
              +----------------------+
```

每层只解决一类问题：

- discovery 找市场；
- strategy/intel 判断展示、通知、关注、买入；
- execution 做资金、授权、预签、广播；
- auto-sell/evidence 管卖出和复盘；
- dashboard/feishu 给 operator 看。

## 2. Discovery layer

发现层输入：

- BNB Chain WSS controller logs；
- HTTP `eth_getLogs` 回放；
- 42 REST `status=all`；
- 中心 watcher 写出的 `EVENT_DISCOVERY_FEED_FILE`。

发现层输出统一 market record，供各 profile 独立处理。

关键约束：

- feed 是只读观察总线；
- feed 不携带私钥、RPC key、webhook、nonce、fills、sell state；
- consuming profile 仍然要自己做 strategy gate、funding、presign、broadcast 和 receipt。

## 3. Strategy / Intel layer

策略层拆成两条线。

### Display / notify decision

决定市场是否出现在 Dashboard、是否发 Feishu。

典型规则：

- BTC Price 类噪音可过滤；
- daily fixed template 可过滤或仅 Bot4 展示；
- sports side markets 可过滤；
- non-filtered events 对 Bot2/Bot3/Bot5 仍可展示和通知；
- strategy allowlist 不应该把 Dashboard 观察面完全遮掉。

### Buy decision

决定 profile 是否允许自动买。

典型来源：

- manual follow；
- planned-buy record；
- Bot2/Bot5 Meme or Binance strong focus；
- Bot3-only FIFA/Sports exact-score selector；
- Bot4 daily-template buy allowlist。

重要边界：

> 展示和通知不是买入许可。买入许可也不是最终交易，仍需资金、授权、时间窗口和风控通过。

### Event intelligence

`src/event-intel.js` 是只读 sidecar：

- 生成中文解释；
- 标记 fixed template / price / non-template；
- 判断 Binance relation；
- 生成 Feishu card；
- 写 JSON/Markdown report。

它不阻塞 premium watcher，不阻塞 execution hot path。

## 4. Execution runtime

核心文件：`src/event-sniper.js`。

典型执行路径：

```text
market discovered
  -> normalize
  -> select outcomes
  -> funding check
  -> allowance check
  -> enter hot window
  -> build calldata
  -> presign raw tx
  -> scheduled broadcast
  -> async receipt
  -> fills / decisions / gas ledger
```

设计重点：

- hot path 不做慢搜索；
- 预签后广播优先；
- buy 和 sell 共用 transaction lock；
- 不默认开盘前广播；
- open-window deadline 是硬边界；
- receipt 后台处理，避免阻塞下一场；
- raw tx fanout 可发多个 RPC；
- 所有链写入都进 profile-local Gas ledger。

## 5. Auto-sell / Evidence

卖出策略包括：

- `ladder`：收益门槛后分批卖；
- `open_timed_exit`：开盘后固定时间卖；
- `pre_start_exit`：比赛或事件开始前卖；
- `hold_to_settlement`：持有到结算或人工处理。

证据工具包括：

- fills；
- market decisions；
- Gas ledger；
- buy-rank evidence；
- premium watcher output；
- Dashboard action log。

项目强调可审计：不仅要知道结果，还要能复盘原因。

## 6. Operator surface

Dashboard 目标：

- 即将开盘；
- 当前持仓；
- 历史项目；
- PnL；
- Gas cost；
- wallet funding；
- worker health；
- manual sell guard。

Feishu 目标：

- 关键告警；
- 新事件通知；
- 低资金临近提醒；
- buy failure / receipt failure；
- auto-sell failure；
- 避免重复噪音。

## 7. Multi-profile runtime

生产形态：

```text
/opt/42space
  src/
  public/
  docs/
  package.json

/etc/42space/profiles/<profile>.env
/opt/42space/data/<profile>/

42space-event@<profile>.service
42space-dashboard@<profile>.service
```

共享：

- code；
- dependencies；
- static dashboard assets；
- optional read-only discovery feed。

隔离：

- private key；
- wallet；
- RPC；
- Feishu webhook；
- dashboard port；
- runtime config；
- seen/fills/decisions；
- nonce；
- auto-sell state；
- dashboard action log。

Current profiles:

| Profile | Role |
| --- | --- |
| `42space` | Bot1, main production / planned-buy validation |
| `42space-2` | Bot2, A/B and focus-buy profile |
| `42space-3` | Bot3, exact-score profile |
| `42space-4` | Bot4, daily-template profile |
| `42space-5` | Bot5, staged Bot2-like profile |

## 8. Repository map

| Path | Responsibility |
| --- | --- |
| `src/event-sniper.js` | trading runtime |
| `src/event-strategy.js` | display/buy decisions |
| `src/event-intel.js` | intelligence sidecar |
| `src/event-premium-watch.js` | read-only watcher/feed |
| `src/fortytwo.js` | 42/chain API wrapper |
| `src/dashboard-server.js` | dashboard API |
| `public/` | dashboard UI |
| `ops/` | systemd/profile artifacts |
| `scripts/` | operational tools |
| `docs/` | source of truth for plans/todos/facts |

## 9. Local checks

```bash
npm install
cp .env.example .env
npm run verify
npm run event:scan
npm run event:plan
npm run event:doctor -- --wallet 0x...
```

Default env is dry-run.

## 10. Live trading gates

Live trading requires:

```text
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

Before live mode:

- use a hot wallet;
- keep secrets out of Git;
- configure RPC/WSS/broadcast RPC;
- fund BUSDT and BNB;
- run `event:preflight`;
- run `event:approve`;
- run `event:doctor`;
- confirm profile isolation;
- confirm sell policy.

## 11. Documentation contract

Before code changes, read:

- [docs/plan.md](../plan.md)
- [docs/todo.md](../todo.md)
- the relevant `docs/plans/*`;
- the relevant `docs/todos/*`.

After code changes, update docs if scope, strategy, production status, or priority changed.
