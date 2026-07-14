# 42Space 事件市场机器人：从一个新市场说起

这是一版“故事导入型” README。它适合完全没接触过 42Space 的人。

## 先看一个场景

假设你打开 42Space，看到一个问题：

> France vs Sweden 会出现哪个比分？

下面有很多选项：

- France 1-0 Sweden
- France 2-0 Sweden
- France 2-1 Sweden
- Draw 1-1
- Sweden 1-0 France

在 42Space 里，这类问题就是一个事件市场。每个选项叫一个 outcome。你买某个 outcome，就是买一份“这个结果会发生”的链上凭证。

如果你买了 `France 2-1 Sweden`，你不是在买普通股票，也不是在下注一个网站数据库里的数字。你是在链上拿到对应的 `Outcome Token`。市场结算前，有些 Event Market 可以卖出；市场结算后，正确结果的持有人可以拿到对应价值。

这就是 42Space 最基本的心智模型：

```text
一个问题
  -> 多个可能结果
  -> 买某个结果的 Outcome Token
  -> 等结算，或在结算前卖出
```

## 那这个项目在干什么

这个项目不是 42Space 官方服务，也不是预测神器。

它做的是另一件事：把人手动盯盘、判断、准备交易、记录证据的流程自动化。

如果完全靠人手动做，一个新市场出现时，你要：

1. 发现它；
2. 判断它是不是你关心的类型；
3. 看它什么时候开盘；
4. 判断买哪些 outcome；
5. 检查钱包有没有 BUSDT 和 BNB；
6. 检查 Router 授权够不够；
7. 到开盘后合适时间发交易；
8. 等 receipt；
9. 记录花了多少 Gas；
10. 后续决定卖出、持有或复盘。

这个项目把这些动作串成流水线。

## 一句话核心思想

核心思想不是“让 AI 自动赌对一切”，而是：

> 把 42Space 事件市场的发现、判断、执行、卖出、证据记录和人工可观察性，做成一条能复盘的自动化流水线。

买或不买都要有记录。成功或失败都要能查。每个 Bot 为什么这么做，都要能从配置、日志、Dashboard 和 docs 里追出来。

## 系统像什么

可以把它想成一支小队。

### 侦察员：发现新市场

它负责盯着 42Space 和 BNB Chain：

- 42 REST 提供比较完整的网站视角；
- 链上日志提供更快的市场创建信号；
- 中心 watcher 可以把发现到的新市场写成共享 feed。

它的任务不是买，而是先发现。

### 分拣员：决定展示、通知、关注、买入或跳过

发现一个市场之后，系统不会马上买。

它会先分拣：

- 这个市场要不要显示在 Dashboard？
- 要不要发飞书？
- 是不是 daily template？
- 是不是 FIFA/Sports exact-score？
- 是不是 Meme 或 Binance strong 事件？
- 有没有被手动 follow？
- 有没有 planned buy？

一个市场可以“展示但不买”，也可以“通知但不买”。这是项目里很重要的边界。

### 执行员：准备交易，到点广播

如果某个 profile 的规则允许买，执行层会继续做：

- 检查 BUSDT；
- 检查 BNB Gas；
- 检查 Router allowance；
- 开盘前进入 hot window；
- 预构建和预签交易；
- 到配置的开盘后时间广播 raw transaction；
- 后台等待 receipt。

这里追求的是速度和边界，不是临场再慢慢查一堆东西。

### 记录员：把发生过的事写下来

它会写：

- fills：买入/卖出记录；
- market decisions：为什么买、为什么跳过、为什么失败；
- Gas ledger：每笔链上交易花了多少 BNB/USDT；
- buy-rank evidence：同一个市场里，我们这笔买入排第几。

这些记录用于复盘，不靠记忆。

### 值班台：Dashboard 和飞书

Dashboard 给人看：

- 即将开盘；
- 当前持仓；
- 历史项目；
- PnL；
- Gas；
- 资金状态；
- worker 是否健康。

飞书只发关键告警，避免普通噪音刷屏。

## 为什么有多个 Bot

生产环境不是一个大 Bot，而是多个 profile。

它们共享同一份代码，但不共享交易状态。

原因很简单：一个钱包的 nonce、资金、RPC 或自动卖出状态出问题，不应该拖垮其他钱包。

| Profile | 大白话角色 |
| --- | --- |
| `42space` / Bot1 | 主生产 profile，偏人工计划买入和执行验证。 |
| `42space-2` / Bot2 | A/B 和 focus-buy profile，偏 Meme / Binance strong 事件。 |
| `42space-3` / Bot3 | FIFA/Sports exact-score 相关 profile。 |
| `42space-4` / Bot4 | daily template profile，关注固定每天出现的模板市场。 |
| `42space-5` / Bot5 | staged Bot2-like profile，用独立钱包复刻 Bot2 路线。 |

每个 profile 都应该有自己的：

- 钱包和私钥；
- RPC；
- Feishu webhook；
- dashboard 端口；
- runtime config；
- seen/fills/decision files；
- nonce；
- 自动卖出状态。

## 项目目录怎么读

| 路径 | 你先这样理解 |
| --- | --- |
| `src/event-sniper.js` | 主机器人入口：发现、计划、买入、卖出、状态检查。 |
| `src/event-premium-watch.js` | 只读 watcher：观察新市场和开盘成本变化，不下单。 |
| `src/event-intel.js` | 事件情报：给新事件做中文解释、分类和飞书卡片。 |
| `src/dashboard-server.js` | Dashboard 后端。 |
| `public/` | Dashboard 前端。 |
| `ops/` | systemd service/timer 和 profile 模板。 |
| `scripts/` | 健康检查、Gas 回填、买入排名证据等工具。 |
| `docs/` | 生产事实、计划、todo 和细节设计。 |

## 新人先跑什么

只跑 dry-run 和只读命令：

```bash
npm install
cp .env.example .env
npm run verify
npm run event:scan
npm run event:plan
npm run event:doctor -- --wallet 0x...
npm run event:positions -- --wallet 0x...
```

默认 `.env.example` 不会真实交易：

```text
DRY_RUN=1
EXECUTE=0
PRIVATE_KEY=
```

## 真实交易前先停一下

真实交易必须显式打开：

```text
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

并且你要确认：

- 使用小额热钱包，不用主钱包；
- 私钥不进 Git；
- RPC/WSS 配好；
- 钱包有 BUSDT 和 BNB；
- Router allowance 够；
- 没有两个服务共用同一私钥；
- 卖出策略符合预期；
- `npm run verify` 通过；
- `npm run event:doctor` 没有阻塞项。

## 下一步读什么

- 当前生产状态：[docs/todo.md](../todo.md)
- 多 profile 运行：[docs/plans/07-single-install-multi-profile-runtime.md](../plans/07-single-install-multi-profile-runtime.md)
- 执行与风险：[docs/plans/03-execution-risk.md](../plans/03-execution-risk.md)
- 事件情报：[docs/plans/08-event-intelligence.md](../plans/08-event-intelligence.md)
- Dashboard：[docs/plans/04-dashboard-ops.md](../plans/04-dashboard-ops.md)
