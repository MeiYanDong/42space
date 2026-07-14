# 42Space Bot 操作者上手手册

这是一版“操作者手册型” README。它按“我现在要怎么安全看项目、跑只读命令、理解状态”来写。

## 先别急着跑实盘

这个项目能发真实链上交易。新人第一原则：

> 先只读，先 dry-run，先看 Dashboard 和 docs。不要直接用生产钱包跑真实买入。

默认 `.env.example` 是安全的：

```text
DRY_RUN=1
EXECUTE=0
PRIVATE_KEY=
```

只要你没有显式改成 `DRY_RUN=0` 和 `EXECUTE=1`，本地默认不会真实下单。

## 42Space 是什么

42Space 是一个事件市场。一个市场会问一个问题，然后列出多个可能结果。

例子：

```text
问题：某场比赛会出现哪个比分？
结果：1-0、2-0、2-1、1-1、0-1...
```

你买某个结果，就是买这个结果的 `Outcome Token`。如果后面结果成立，这个 token 就有结算价值。有些 Event Market 在结算前也可以卖出。

本项目不是 42Space 官方服务，也不是预测正确率保证。它是操作者的自动化工具。

## 这个工具帮你做什么

从操作者角度，它做五件事：

1. 看见新市场；
2. 判断这个市场要不要展示/提醒/买；
3. 如果要买，提前准备交易；
4. 买完后记录证据和处理卖出；
5. 用 Dashboard 和飞书让你知道系统状态。

## 第一次本地启动

```bash
npm install
cp .env.example .env
npm run verify
```

`npm run verify` 会做语法检查和自检。它不需要真实买入。

## 第一次看市场

```bash
npm run event:scan
npm run event:plan
```

你可以理解为：

- `event:scan`：看看现在有什么 42 Event Markets；
- `event:plan`：按当前规则模拟如果要买，会选哪些 outcomes。

## 第一次查钱包

只传钱包地址，不传私钥：

```bash
npm run event:doctor -- --wallet 0x...
npm run event:positions -- --wallet 0x...
```

你可以理解为：

- `event:doctor`：检查这个钱包能不能跑当前配置；
- `event:positions`：看看这个钱包在 42Space 上有什么持仓。

## 第一次打开 Dashboard

```bash
npm run dashboard
```

Dashboard 主要看：

- 即将开盘；
- 当前持仓；
- 历史项目；
- PnL；
- Gas；
- 资金状态；
- Bot worker 是否健康。

如果你看到一个市场出现在 Dashboard，不代表 Bot 一定会买。展示、通知、买入是三件事。

## 关键心智模型

```text
发现市场
  -> 分类和过滤
  -> 生成买入计划
  -> 检查资金和授权
  -> 预签交易
  -> 开盘后广播
  -> 等 receipt
  -> 写 fills / decisions / Gas
  -> 自动卖出或持有
```

这个项目最重视的是可复盘。每一步都应该留下记录。

## 多 Bot 怎么看

生产不是一个 Bot 跑所有事，而是多个 profile 分开跑。

| Profile | 你可以先这样记 |
| --- | --- |
| Bot1 | 主生产/人工计划验证 |
| Bot2 | A/B 和 focus-buy |
| Bot3 | 体育准确比分 |
| Bot4 | 每天固定模板 |
| Bot5 | 独立钱包复刻 Bot2 路线 |

多个 profile 共享代码，但不共享钱包、私钥、RPC、webhook、nonce 和状态。

这很重要。链上交易有顺序号 nonce，如果两个进程拿同一个私钥乱发交易，会互相干扰。

## 真实交易前 checklist

真实交易开关：

```text
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
```

打开之前确认：

- [ ] 使用小额热钱包；
- [ ] 私钥不写入 Git；
- [ ] RPC/WSS 配置可用；
- [ ] BUSDT 足够；
- [ ] BNB 足够支付 Gas；
- [ ] Router allowance 足够；
- [ ] `npm run verify` 通过；
- [ ] `npm run event:doctor` 无阻塞；
- [ ] 没有另一个服务使用同一私钥；
- [ ] 你理解当前 profile 买入规则；
- [ ] 你理解当前 profile 卖出规则；
- [ ] Dashboard 和日志能查到状态。

实盘长期入口：

```bash
npm run event:preflight
npm run event:approve
npm run event:arm
```

`event:arm` 会长期运行，等待资金和市场，触发买入，并启动自动卖出监控。没有理解配置前，不要直接在生产钱包上跑。

## 常见术语

| 词 | 大白话 |
| --- | --- |
| Outcome | 一个可能结果。 |
| Outcome Token | 买某个结果后拿到的链上凭证。 |
| BUSDT | 买入用的稳定币资产。 |
| BNB | 支付 Gas 的资产。 |
| Gas | 链上手续费。 |
| Router allowance | 提前授权合约能花多少 BUSDT。 |
| Nonce | 钱包发交易的顺序号。 |
| Receipt | 链上交易成功/失败的证明。 |
| Fills | 买入/卖出记录。 |
| Market decisions | 为什么买或不买的流水。 |
| Planned buy | 人工预先指定买哪些 outcomes。 |
| Hot window | 开盘前后的关键时间段。 |
| Auto-sell | 自动卖出。 |

## 目录速查

| 路径 | 看什么 |
| --- | --- |
| `README.md` | 项目入口 |
| `docs/todo.md` | 当前生产状态 |
| `docs/plan.md` | 项目阶段总览 |
| `src/event-sniper.js` | 主交易逻辑 |
| `src/event-intel.js` | 事件情报 |
| `src/event-premium-watch.js` | 只读 watcher |
| `src/dashboard-server.js` | Dashboard 后端 |
| `ops/` | 生产服务模板 |
| `scripts/` | 运维和证据工具 |

## 下一步阅读

- 生产多 profile：[docs/plans/07-single-install-multi-profile-runtime.md](../plans/07-single-install-multi-profile-runtime.md)
- 执行和风控：[docs/plans/03-execution-risk.md](../plans/03-execution-risk.md)
- Dashboard：[docs/plans/04-dashboard-ops.md](../plans/04-dashboard-ops.md)
- 事件情报：[docs/plans/08-event-intelligence.md](../plans/08-event-intelligence.md)
