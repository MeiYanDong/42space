# 42Space Event Market Automation

这是一版“产品说明型” README。它先回答：这个工具是什么、为谁服务、解决什么问题、不解决什么问题。

## 它是什么

`42space` 是一套 42Space Event Market 自动化运行工具。

42Space 是事件结果交易市场。一个市场提出一个问题，下面有多个可能结果。用户可以买某个结果的 `Outcome Token`。如果结果最终成立，持有人可以在结算中获得对应价值；有些 Event Market 在结算前也可以卖出。

本项目围绕这个流程提供自动化能力：

- 新市场发现；
- 事件分类；
- 展示和通知过滤；
- profile-local 买入规则；
- 开盘前预构建、预签名；
- 开盘后广播；
- receipt 和 Gas 记录；
- 自动卖出；
- Dashboard 和 Feishu 运维。

它不是 42Space 官方服务，不承诺收益，不替代人工策略判断。

## 它解决的问题

### 1. 新市场发现太快，人工容易漏

42Space 市场可能通过网站、REST、链上日志等路径暴露。人工刷新网页很容易漏掉开盘窗口。

项目通过 WSS、链上回放、REST 和共享 discovery feed 发现市场。

### 2. 展示、通知和买入容易混在一起

一个市场“值得看”不等于“应该买”。本项目把三件事分开：

- 展示：Dashboard 里要不要出现；
- 通知：要不要飞书提醒；
- 买入：某个 profile 是否允许自动执行。

这样 Bot3 可以看 exact-score，Bot4 可以只看 daily template，Bot2/Bot5 可以按自己的 focus 规则处理 Meme/Binance strong 事件。

### 3. 开盘交易需要提前准备

开盘后再慢慢查余额、查授权、构造交易，会错过时机。

执行层会提前检查资金和授权，在 hot window 里预构建/预签名，到配置时间广播 raw transaction。

### 4. 交易后必须能复盘

只知道“买了”不够。还要知道：

- 为什么买；
- 为什么没买；
- 什么时候广播；
- 哪个 RPC 首先接受；
- receipt 成功还是失败；
- Gas 花了多少；
- 同市场里我们的买入排名如何；
- 自动卖出是否按规则执行。

项目通过 fills、market decisions、Gas ledger、buy-rank evidence 和 Dashboard 记录这些证据。

## 它不解决的问题

- 不保证预测正确；
- 不保证买入排名第一；
- 不保证一定成交或盈利；
- 不绕过 42Space 合约规则；
- 不替你管理主钱包；
- 不把 event intelligence 当成同步买入决策；
- 不允许把秘密写进 Git。

## 核心产品能力

| 能力 | 说明 |
| --- | --- |
| Market discovery | 从链上日志、REST 和 feed 发现当前/未来市场。 |
| Display filters | 控制 Dashboard 和通知里显示哪些市场。 |
| Buy filters | 控制某个 profile 是否允许自动买。 |
| Planned buys | 人工指定某个市场买哪些 outcomes、多少钱、什么 timing/gas。 |
| Pre-signing | 开盘前提前签好交易，开盘后直接广播。 |
| Auto-sell | 按 profile 策略分批卖、定时卖、赛前卖或持有。 |
| Gas ledger | 记录每笔链上交易成本。 |
| Dashboard | 展示即将开盘、持仓、PnL、健康状态。 |
| Feishu alerting | 发送关键告警，减少重复噪音。 |
| Multi-profile runtime | 一份代码，多套独立 Bot 配置和状态。 |

## 系统框架

```text
输入来源
  42 REST / BNB Chain logs / shared feed

市场处理
  normalize -> classify -> display/notify/buy decision

交易执行
  funding -> allowance -> plan -> presign -> broadcast -> receipt

交易后处理
  fills -> gas ledger -> market decisions -> auto-sell -> evidence

操作界面
  Dashboard -> Feishu -> docs
```

## Profile 模型

生产模型是“单代码安装，多 profile 运行”。

共享：

- 程序代码；
- Dashboard 静态资源；
- 可选只读 discovery feed。

隔离：

- 私钥；
- 钱包；
- RPC；
- webhook；
- dashboard 端口；
- runtime config；
- seen/fills/decision files；
- nonce；
- auto-sell state。

| Profile | 定位 |
| --- | --- |
| Bot1 / `42space` | 主生产和 planned-buy 执行验证。 |
| Bot2 / `42space-2` | A/B focus-buy profile。 |
| Bot3 / `42space-3` | FIFA/Sports exact-score profile。 |
| Bot4 / `42space-4` | daily-template profile。 |
| Bot5 / `42space-5` | 独立钱包的 Bot2-like staging profile。 |

## 目录导览

```text
src/
  event-sniper.js          主交易机器人入口
  event-premium-watch.js   只读 premium watcher
  event-intel.js           事件情报 sidecar
  dashboard-server.js      Dashboard 后端

public/                    Dashboard 前端
ops/                       systemd 和 profile 模板
scripts/                   证据、回填、健康检查工具
docs/                      项目事实和设计文档
data/                      本地状态
output/                    本地报告和证据
```

## 快速体验

默认只做 dry-run。

```bash
npm install
cp .env.example .env
npm run verify
npm run event:scan
npm run event:plan
npm run dashboard
```

只读检查钱包：

```bash
npm run event:doctor -- --wallet 0x...
npm run event:positions -- --wallet 0x...
```

## 真实交易门槛

真实交易前必须读 [docs/plans/03-execution-risk.md](../plans/03-execution-risk.md)。

最低要求：

- 小额热钱包；
- 私钥不入 Git；
- RPC/WSS 配好；
- BUSDT/BNB 足够；
- Router allowance 准备好；
- `npm run verify` 通过；
- `npm run event:doctor` 无阻塞；
- 没有两个 profile 共用同一个 signer。

真实开关：

```text
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

## 文档入口

- 总纲：[docs/plan.md](../plan.md)
- 当前状态：[docs/todo.md](../todo.md)
- 生产 runtime：[docs/plans/07-single-install-multi-profile-runtime.md](../plans/07-single-install-multi-profile-runtime.md)
- 执行风险：[docs/plans/03-execution-risk.md](../plans/03-execution-risk.md)
- Dashboard：[docs/plans/04-dashboard-ops.md](../plans/04-dashboard-ops.md)
- 事件情报：[docs/plans/08-event-intelligence.md](../plans/08-event-intelligence.md)
