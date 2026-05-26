# 42 Market Sniper

42 市场扫描和开盘抢筹程序。默认只做 dry-run：扫描 42 live markets，先打印计划，不会发真钱交易。

## 安装

```bash
npm install
cp .env.example .env
```

## 常用命令

```bash
npm run scan
npm run watch
npm run buy -- --market 0xb35953C77E03c6b2953c40844051508f31Be477B --token-id 32 --stake-usdt 5
```

## Event Market：发现新场后每个结果都买

当前文档确认的边界：

- REST API 仍是 Alpha 读接口，没有文档化的下单/授权交易 API。
- Event Markets 可以在结算前卖出；Price Markets 不能卖出，会锁到结算。
- 真实交易走 BNB Chain 合约：`FTRouterProxy`、`FTLensV2`、`BUSDT`。

RPC 配置优先读项目 `.env.local` / `.env`，再读 `~/.codex/secrets/evm-rpc-providers.env`，最后才用 public RPC。不要把 Ankr/Chainstack key 写进 README 或提交到 Git；支持的变量名是 `BSC_RPC_URL` / `CHAINSTACK_BSC_RPC_URL` / `ANKR_BSC_RPC_URL`，WSS 是 `BSC_WS_URL` / `CHAINSTACK_BSC_WS_URL` / `ANKR_BSC_WS_URL` / `ANKR_BSC_WS_RPC_URL`。

查看当前 live Event Markets：

```bash
npm run event:scan
```

查看某个钱包的 42 开放持仓：

```bash
npm run event:positions -- --wallet 0x244FcE72db40B69C4DA4D41F0a76E25B24CA201b
```

查看下一批同期开盘 Event Markets 的实盘资金门槛、当前钱包缺多少 BUSDT/BNB、是否已经能直接 `event:arm`。Event Market 默认每场只买赔率最低的 5 个 outcome，每个 outcome 买 `5U`，实盘前仍建议显式带上 `STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5`：

```bash
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 npm run event:funding -- --wallet 0x244FcE72db40B69C4DA4D41F0a76E25B24CA201b
```

查看某个 outcome 的卖出报价。默认 dry-run，只读链上余额并用 market 的 `redeemExactOtToCollateral` 报价；真实卖出会先给当前 market 设置 Router operator，再通过 `FTRouterProxy.swap(isMint=false)` 带滑点保护卖出：

```bash
npm run event:sell -- --wallet 0x244FcE72db40B69C4DA4D41F0a76E25B24CA201b --market 0x73CbB55E357fA4Ceb2d808FF7A908A7a045F6ca5 --token-id 16 --percent 100
```

如果要一次查看/卖出同一 market 下所有持仓，显式加 `--all`：

```bash
npm run event:sell -- --wallet 0x... --market 0x... --all --percent 100
```

真实卖出时不要把私钥写进命令；命令会弹出隐藏输入框：

```bash
DRY_RUN=0 EXECUTE=1 I_UNDERSTAND_42_PRICE_MARKET_RISK=YES I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES npm run event:sell -- --market 0x... --token-id 16 --percent 100
```

自动止盈按真实链上卖出报价判断，不按页面展示赔率判断。默认规则是：某个 outcome 的 100% 可卖出报价达到当前成本的 `2x` 后，只卖出该 outcome 的 `50%`，且同一个 outcome 只自动触发一次：

```bash
npm run event:autosell
DRY_RUN=0 EXECUTE=1 I_UNDERSTAND_42_PRICE_MARKET_RISK=YES I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES npm run event:autosell -- --execute
```

无人值守运行时，把热钱包私钥放到 macOS Keychain 的 `42space-event-bot-private-key` 条目；程序会自动读取，不再弹窗。`PRIVATE_KEY` 环境变量仍然优先于 Keychain：

```bash
security add-generic-password -a 42space -s 42space-event-bot-private-key -w '0x...' -U
```

模拟最近一个 Event Market，按当前 `EVENT_OUTCOME_SELECTION` 选择 outcome。默认是 `lowest_odds`，即优先按 `payout` 从小到大选 5 个；如果 REST/链上数据没有完整 payout 但有 price，则按 price 从大到小选；如果刚开场链上日志还没有赔率字段，默认按 token 顺序兜底并在 plan 里标记 `rankSource: token_order`。这个命令会逐 outcome 调 `FTLensV2.simulateMint`，用于分析，不是最快路径：

```bash
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 MAX_MARKET_STAKE_USDT=25 npm run event:plan
```

指定市场模拟：

```bash
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 npm run event:plan -- --market 0x73CbB55E357fA4Ceb2d808FF7A908A7a045F6ca5
```

监听新 Event Market。默认启动时会把现有 live Event Markets 标记为已见，只等新场；如果要启动后连现有场也买，设置 `WATCH_BUY_EXISTING=1`。

```bash
POLL_MS=500 STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 npm run event:watch
```

实盘长期在线入口使用隐藏输入私钥，不把私钥写进 `.env`：

```bash
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 MAX_MARKET_STAKE_USDT=25 npm run event:arm
```

速度模式：

- `npm run verify`：本地确定性检查，包含语法检查和无需下一场真实市场的 Event Market 自检。
- `npm run event:bench -- --samples 5`：离线 benchmark 下一批同期开盘 bundle 的 plan 构建、bundle 编码、预签耗时；使用公开测试私钥，不广播。
- `npm run event:rpc`：预热并测速 broadcast RPC 池，只输出 provider 域名、区块号、延迟和错误摘要，不打印 RPC URL。
- `npm run event:presign-test`：离线验证“pending records -> pre-signed bundle -> cached bundle reuse”链路；使用公开测试私钥，只签名不广播。
- `npm run event:due-test`：离线验证“cached pre-signed bundle -> due drain -> executeDueBundle dry-run”链路；使用公开测试私钥预签、强制到期、dry-run 执行，不广播。
- `npm run event:catchup-test`：离线验证“资金恢复后发现刚开盘未买 markets -> catch-up bundle dry-run”链路；强制把下一批未来 markets 当成刚开盘，不广播。
- `npm run event:deadline-test`：离线验证“开盘窗口过期 -> 标记跳过 -> 不再广播”的硬截止链路，不广播。
- `EVENT_DISCOVERY=ws`：通过 WebSocket 订阅 `FTControllerV2` 的 `CreateNewQuestionV2` / `AddOutcome` / `CreateNewMarket` 日志。默认值，最快，优先使用 `BSC_WS_URL` / `CHAINSTACK_BSC_WS_URL` / `ANKR_BSC_WS_URL` / `ANKR_BSC_WS_RPC_URL`。
- `EVENT_DISCOVERY=chain`：HTTP 轮询同一组 controller 日志，要求 `BSC_RPC_URL` 支持 `eth_getLogs`。
- `EVENT_DISCOVERY=rest`：REST 轮询兜底。
- `WATCH_FUNDING_MODE=next_batch`：实盘 watch 启动前按已知下一批同一开盘时间的 Event Markets 合计资金校验；设为 `upper_bound` 时只按单场 `STAKE_PER_OUTCOME_USDT * min(EVENT_OUTCOME_COUNT, MAX_OUTCOMES_PER_MARKET)` 校验。
- `BUNDLE_DUE_MARKETS=1`、`MAX_BATCH_STAKE_USDT=100`：同一 `startDate` 的多个 due Event Markets 会合并成一笔 `FTRouterProxy.multicall`，用批次上限控制总风险。
- `EVENT_OUTCOME_SELECTION=lowest_odds`、`EVENT_OUTCOME_COUNT=5`：每个 Event Market 只买赔率最低的 5 个 outcome。链上日志缺少赔率字段时，程序会先用 42 单市场 REST 接口按地址补全 outcomes；赔率优先用 `payout` 排序，其次用 `price`，再按 `EVENT_OUTCOME_SELECTION_FALLBACK` 兜底。
- `EVENT_OUTCOME_SELECTION_FALLBACK=token_order`：刚开场链上日志缺少赔率字段时，仍按 token 顺序选 5 个并继续抢；设为 `error` 则缺少赔率数据时直接跳过/报错，保证只在能判断赔率时下单。
- `EVENT_OUTCOME_SELECTION=all`：恢复旧策略，买入该市场全部 outcome。
- `AUTO_SELL_ENABLED=1`、`AUTO_SELL_PROFIT_MULTIPLIER=2`、`AUTO_SELL_PERCENT=50`：长期守护进程会轮询持仓，真实卖出报价达到成本 2 倍后自动卖出一半；已触发的 outcome 会写入 `AUTO_SELL_STATE_FILE`，避免重复半仓卖出。
- `FEISHU_WEBHOOK=`：长期守护进程告警入口。生产环境放在服务器 env，不提交到 Git；会通知启动、资金不足、买入成功/失败、WS/链上降级、自动卖出触发等关键事件。`FEISHU_ALERT_COOLDOWN_MS` 控制同类噪音告警的冷却时间。
- `EVENT_BUY_MODE=fast`：不逐个报价，直接 `minOut=1` 买入选中的 outcome。抢新场默认用这个。
- `EVENT_BUY_MODE=quoted`：先模拟再买，慢但输出更完整。
- `FAST_SKIP_PREFLIGHT=1`：触发时不再查余额/allowance，依赖启动前 `event:preflight` 和 `event:approve`。
- `FAST_SKIP_DUE_REST_HYDRATION=1`：已经到点或 WS 临场发现的 market 不再等待 REST 赔率补全，直接用链上日志 outcomes 生成交易；未来待开盘 market 仍会提前补全赔率并预签。
- `FAST_NONCE_MANAGER=1`：实盘 watch 启动时取一次 pending nonce，后续本地递增，减少触发时 RPC。
- `PRE_SIGN_FAST_TX=1`、`PRE_SIGN_WINDOW_MS=5000`：已知未来场进入开盘前窗口时预签 raw transaction；开盘瞬间只做广播。窗口不要设得太大，避免远期交易提前占用 nonce。
- `PRE_SIGN_RETRY_MS=250`：预签窗口内如果遇到瞬时错误，会按这个间隔重试；nonce 只在签名成功后递增，避免失败预签占用 nonce。
- `NONCE_SYNC_BEFORE_PRESIGN=1`、`NONCE_SYNC_MIN_INTERVAL_MS=250`：预签前按节流频率读取 pending nonce。如果 watch 启动后发生了别的交易，程序会把本地 nonce 推进到链上 pending nonce，避免签出已失效的 raw tx。若预签广播返回 stale nonce 类错误，fallback 会立即读取最新 pending nonce 并重新签名。
- `FANOUT_BROADCAST=1`：fast 实盘广播时签一次 raw transaction，并向多个 HTTP RPC 同时发送；默认从 `BSC_RPC_URL`、`CHAINSTACK_BSC_RPC_URL`、`ANKR_BSC_RPC_URL` 去重生成。
- `BROADCAST_TIMEOUT_MS=1200`：单个广播 RPC 的超时窗口。目标是尽快拿到第一个成功广播，而不是等所有 RPC 慢慢返回。
- `RPC_WARMUP_TIMEOUT_MS=2500`：`event:rpc` 和实盘 `event:watch` 启动时预热 broadcast RPC 的超时窗口。实盘开跑前会先创建并连通 raw-tx client，避免开盘瞬间才初始化 HTTP transport。
- `DOCTOR_CHECK_WS=0`：`event:doctor` 默认不打开 WSS 长连接；要单独测 WSS 时设为 `1`。
- `WATCH_STARTUP_RETRY_MS=5000`：启动时如果 REST 补种、链上回放或 chain watch 初始区块读取遇到瞬时网络错误，按这个间隔告警/重试；WS 模式下 REST/链上补种失败不会直接退出主进程。
- `ARM_WAIT_FOR_FUNDING=1`、`ARM_FUNDING_RETRY_MS=60000`：长期守护进程资金不足时不退出，按普通间隔复查 BUSDT/BNB/allowance；资金补足后自动进入 WS watch。
- `ARM_FUNDING_HOT_WINDOW_MS=600000`、`ARM_FUNDING_HOT_RETRY_MS=1000`：距离下一批开盘小于热窗口时，资金复查自动切到 1 秒，避免临近开盘补款后最多睡 60 秒。
- `ARM_CATCH_UP_AFTER_FUNDING=1`、`ARM_CATCH_UP_WINDOW_MS=60000`：如果守护进程因为资金不足没进入 watch，资金补足后启动时会追赶刚开盘 60 秒内、尚未买过的 Event Markets；catch-up 会为缺少 odds 的 due market 补一次 REST 赔率以尽量严格选择当前配置的最低赔率档，超过窗口仍标记 seen，避免误买老盘。
- `EVENT_LOG_LOOKBACK_BLOCKS=50000`：启动时回放最近 controller 日志，把已创建但未开盘的未来 Event Market 放入 pending，避免开盘时漏买。
- `LOG_CHUNK_BLOCKS=5000`：HTTP 回放/轮询时分块 `eth_getLogs`，避免 Chainstack 这类付费 RPC 的 block range 限制。
- `HOT_POLL_MS=50`、`PREOPEN_HOT_MS=5000`：已知未来开盘场进入开盘前热窗口后，把 pending 检查从普通 `POLL_MS` 切到更高频；最后一跳会按剩余毫秒贴近开盘/预广播点醒来，而不是固定多睡一个完整 hot poll。
- `PREBROADCAST_MS=0`：默认不提前广播。设为几百毫秒时，程序会在开盘前进入广播窗口，可能更快进入 mempool，但如果交易被过早打包，存在 revert 和 nonce 占用风险。
- `WS_RECEIPT_FALLBACK_MS=0`：WS 收到 `CreateNewMarket` 但本地 buffer 里还没齐 outcome 日志时，默认立刻用交易 receipt 补齐同 tx 日志，避免等待 `POLL_MS`。
- WSS receipt fallback 会按 txHash 复用已拉取并解析的创建交易 receipt，避免同一笔创建交易里多个 market 重复 `getTransactionReceipt/getBlock`。
- `FAST_GAS_LIMIT=5000000`、`BUNDLE_FAST_GAS_LIMIT=12000000`、`GAS_PRICE_GWEI=0.12`：避免触发时估 gas 和查 gas price。bundle 会按本批 market/outcome 数计算动态 gas limit，并以 `BUNDLE_FAST_GAS_LIMIT` 作为上限；最近真买样本里 3 outcome 单场约 0.95M gas、9 outcome 单场约 2.70M gas。
- `WAIT_FOR_RECEIPT=1`：广播后等待 receipt，再把 market 标记为已处理；这会让“拿到 hash 但没上链/没成交”的情况暴露出来，避免误判完成。
- `ASYNC_RECEIPT_WATCH=1`、`RECEIPT_WATCH_TIMEOUT_MS=120000`、`RECEIPT_WATCH_POLLING_MS=1000`：如果显式设 `WAIT_FOR_RECEIPT=0`，真实广播后会改为后台等待 receipt，并把成功/失败写入 `FILLS_FILE`。
- `EXECUTION_RETRY_MS=500`：买入执行失败、receipt 未成功或返回非 success 时，不写 seen，保留 pending 并短间隔重试，避免 WS 即时路径丢失新场。
- `EVENT_OPEN_WINDOW_SECONDS=60`：硬截止。市场开盘超过 60 秒仍未成功买入时，程序写入 `event-skip-open-window`，把该 market 加入 seen，并从 pending 删除；之后不会再主动为这个 market 发起买入。

对于已经创建但未来才开盘的 Event Market，watch 会在 pending 阶段提前构建 fast plan；实盘有 signer/receiver 时会进一步预编码 `FTRouterProxy.multicall` calldata。开盘瞬间只做 nonce/gas 已知路径上的签名与广播；同一 startDate 同时开盘的多个 Event Markets 会并行触发，并在广播前立即预留本地 nonce，避免并行交易复用 nonce。

WSS 模式下，`event:watch` 会先建立 controller 日志订阅，再做 REST/链上 startup seed；启动期新出现的市场日志会先进入队列，避免“先回放、后订阅”中间窗口漏事件。WSS 日志到达会立即唤醒监听循环处理，不再等下一次 `POLL_MS` 醒来。实盘 nonce 会在资金预检和 RPC warmup 之后再读取，尽量贴近后续预签/广播。

同一批链上日志里解出多个 market 时，发现后的处理按顺序推进，避免多个立即执行路径同时改本地 nonce。真正同期开盘的 pending markets 仍会优先走 `BUNDLE_DUE_MARKETS=1` 的单笔 bundle 交易。

如果一批新发现的 Event Markets 在发现时已经到达可交易时间，程序会先按相同 `startDate` 尝试即时 bundle，再回退到单 market 顺序执行。这覆盖“创建即开场”的事件批次，减少多笔交易和 nonce 竞争。

钱包/授权预检：

```bash
npm run event:doctor
npm run event:doctor -- --wallet 0x...
npm run event:preflight
```

`event:doctor` 会按链上已知的下一批同期开盘 Event Markets 计算所需 BUSDT；`requiredBusdt` 是当前 `WATCH_FUNDING_MODE` 下的真实启动门槛，`requiredBusdtUpperBound` 只是单场兜底上限，不代表下一批一定只需要这么多。加 `--wallet` 可以只读检查 bot 地址的余额和 allowance，不需要加载私钥。doctor/preflight 还会估算 fast 交易的 BNB gas reserve：固定 gas limit 的交易在广播前需要账户能覆盖 `gasLimit * gasPrice`，即使最后实际消耗低于 gas limit。

实盘前必须提前授权 Router。不要等新场出现后才授权，否则会多一笔交易，速度会输：

```bash
npm run event:approve
```

回放最近链上 controller 生命周期日志，验证解析、过滤和 fast plan 构造：

```bash
npm run event:replay
```

查看长期 bot 状态、资金上限、最近 live 场和未来 pending Event Market：

```bash
npm run event:status -- --wallet 0x...
```

用最近的未来 Event Market 做 dry-run 演练，不发交易，只验证“链上发现 -> 预构建 fast plan -> 到点执行计划”的本地路径：

```bash
npm run event:rehearse
```

## 策略

- `binance_volume_projection`：针对 `BTC/USDT Futures Daily Volume` 这类市场，从 Binance Futures 读取 BTCUSDT 日线成交额，用最近完整日均值和当日实时成交额估算最终区间。
- `binance_price_projection`：针对 `BTC price range` 这类市场，从 Binance spot 读取 BTCUSDT 当前价格，选择当前价格所在区间。
- `cheapest`：选择当前价格最低的 outcome。
- `configured`：必须设置 `TARGET_OUTCOME_REGEX`，按正则选择 outcome。

查看 BTC 价格区间场：

```bash
TARGET_TOPIC=Bitcoin TARGET_QUESTION_REGEX='BTC price range' STRATEGY=binance_price_projection npm run scan
```

如果 42 后续标签又变了，可以去掉 topic 过滤：

```bash
TARGET_TOPIC= TARGET_QUESTION_REGEX='BTC price range' STRATEGY=binance_price_projection npm run scan
```

## 真实买入开关

真实链上买入只支持 42 V2 market。分析命令 `event:plan` 会用 `FTLensV2.simulateMint` 模拟选中的 outcome；抢新场默认走 fast 模式，直接通过 `FTRouterProxy.multicall` 批量调用 `swap`。要执行真买入，`.env` 必须同时设置：

```bash
DRY_RUN=0
EXECUTE=1
I_UNDERSTAND_42_PRICE_MARKET_RISK=YES
I_AM_NOT_IN_RESTRICTED_JURISDICTION=YES
PRIVATE_KEY=0x...
BSC_RPC_URL=...
```

Event Market 实盘命令：

```bash
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 MAX_MARKET_STAKE_USDT=25 npm run event:minimal
STAKE_PER_OUTCOME_USDT=5 EVENT_OUTCOME_COUNT=5 MAX_MARKET_STAKE_USDT=25 npm run event:buy
```

为了速度，fast `event:watch` 不会在发现新场后临时发 approve，也不会再逐笔 simulate、查余额、查 allowance。它假设启动前已经 `event:preflight` 和 `event:approve`，然后直接广播批量 mint；默认等待 receipt 后再落 seen 状态。`event:approve` 会提前把 BUSDT 对 Router 的 allowance 批到最大值；不要在主钱包里运行，使用小额热钱包。

注意：Price Markets 文档明确说退出不允许，买入后通常只能等结算。开盘抢筹也不保证成交顺序或收益，REST 轮询不是 mempool 级抢跑。
