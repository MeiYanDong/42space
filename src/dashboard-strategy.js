const PROFILE_KINDS = new Set(["bot1", "bot2", "bot3", "bot4", "bot5"]);

export function dashboardProfileKind(cfg = {}) {
  const name = String(cfg.botName ?? "").trim().toLowerCase();
  const role = String(cfg.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  if (name === "42space-2" || name === "bot2" || name.startsWith("bot2")) return "bot2";
  if (name === "42space-3" || name === "bot3" || name.startsWith("bot3")) return "bot3";
  if (name === "42space-4" || name === "bot4" || name.startsWith("bot4") || name.includes("bot4")) return "bot4";
  if (name === "42space-5" || name === "bot5" || name.startsWith("bot5") || name.includes("bot5")) return "bot5";
  if (role === "bot2_like") return "bot5";
  return "bot1";
}

export function buildDashboardStrategyProfile(cfg = {}, watchConfig = {}) {
  const kind = dashboardProfileKind(cfg);
  const profile = profileIdentity(kind, cfg);
  const buy = buyPolicy(kind, cfg, watchConfig);
  const execution = executionPolicy(kind, cfg, watchConfig);
  const exit = exitPolicy(kind, cfg, watchConfig);
  const live = !(Boolean(cfg.dryRun) || cfg.execute === false);
  const stopLoss = stopLossText(cfg, watchConfig);
  const plannedPriority = plannedPriorityText(kind, cfg);

  return {
    kind,
    profile: String(cfg.botName ?? profile.label),
    eyebrow: profile.eyebrow,
    title: profile.title,
    summary: profileSummary(kind, buy, execution, exit),
    badges: [
      { label: live ? "实盘" : "只读", tone: live ? "live" : "neutral" },
      { label: buy.badge, tone: "focus" },
      { label: execution.badge, tone: execution.tone },
      { label: stopLoss.enabled ? "止损开启" : "止损关闭", tone: stopLoss.enabled ? "risk" : "neutral" }
    ],
    stages: [
      { step: "01", icon: "sparkles", label: "市场范围", ...buy.stage },
      { step: "02", icon: "layers-3", label: "默认买入", ...buy.selectionStage },
      { step: "03", icon: "send", label: "执行通道", ...execution.stage },
      { step: "04", icon: "timer", label: "自动退出", ...exit.stage }
    ],
    facts: [
      { label: "自动范围", value: buy.factValue, detail: buy.factDetail, tone: "focus" },
      { label: "默认下单", value: buy.selectionStage.title, detail: buy.selectionStage.detail, tone: "neutral" },
      { label: "买入执行", value: execution.stage.title, detail: execution.factDetail, tone: execution.tone },
      { label: "自动卖出", value: exit.stage.title, detail: exit.factDetail, tone: exit.tone },
      { label: "止损规则", value: stopLoss.text, detail: stopLoss.detail, tone: stopLoss.enabled ? "risk" : "neutral" },
      { label: "配置优先级", value: "planned-buy > Profile 默认", detail: plannedPriority, tone: "neutral" }
    ],
    overrideNote: plannedPriority,
    sellMode: exit.mode,
    sellModeLabel: exit.modeLabel,
    sellSummary: `${exit.stage.title} / ${stopLoss.text}`,
    executionMode: execution.mode,
    executionSummary: execution.stage.title
  };
}

function profileIdentity(kind, cfg) {
  const configuredName = String(cfg.botName ?? "").trim();
  if (kind === "bot1" && isExactScoreStrategy(cfg)) {
    return { label: configuredName || "Bot1", eyebrow: "BOT1 PROFILE", title: "FIFA 精确比分自动买入" };
  }
  if (kind === "bot2") {
    return { label: configuredName || "Bot2", eyebrow: "BOT2 PROFILE", title: "Meme 事件自动买入" };
  }
  if (kind === "bot3") {
    return { label: configuredName || "Bot3", eyebrow: "BOT3 PROFILE", title: "FIFA 精确比分自动买入" };
  }
  if (kind === "bot4") {
    return { label: configuredName || "Bot4", eyebrow: "BOT4 PROFILE", title: "日常固定模板计划买入" };
  }
  if (kind === "bot5") {
    return { label: configuredName || "Bot5", eyebrow: "BOT5 PROFILE", title: "Bot2-like 独立执行" };
  }
  return { label: configuredName || "Bot1", eyebrow: "BOT1 PROFILE", title: "主策略与计划买入" };
}

function buyPolicy(kind, cfg, watch) {
  const focusEnabled = String(cfg.eventIntelBuyFilter ?? "off").trim().toLowerCase() === "strong";
  const fallbackSelection = selectionPolicy(cfg, watch);
  const maxMarketStake = numeric(watch.maxMarketStakeUsdt ?? cfg.maxMarketStakeUsdt, fallbackSelection.totalStake);

  if (isExactScoreStrategy(cfg, kind) && Boolean(cfg.bot3FifaExactScoreAutoBuyEnabled)) {
    const stake = numeric(cfg.bot3FifaExactScoreAutoStakeUsdt, 1);
    const totalStake = stake * 5;
    return {
      badge: "精确比分",
      factValue: "仅 FIFA/Sports 精确比分",
      factDetail: "普通事件买入白名单关闭；平局、总进球、净胜球、Moneyline 等边盘不进入自动买入。",
      stage: {
        title: "FIFA 精确比分",
        detail: "比较主胜与客胜标准比分档的 outcome.price，只选择价格更低的胜方；平局不买。",
        meta: ["精确比分", "边盘排除", "planned-buy 优先"]
      },
      selectionStage: {
        title: `胜方 5 项 x ${formatNumber(stake)}U`,
        detail: "主胜买 1-0/2-0/3-0/2-1/3-1；客胜买 0-1/0-2/0-3/1-2/1-3。",
        meta: [`单场 ${formatNumber(totalStake)}U`, "不买平局", "按 price 分档"]
      }
    };
  }

  if (kind === "bot4") {
    const plannedStakeRows = bot4PlannedStakeRows(watch.plannedBuyPlans);
    const plannedStakeDetail = plannedStakeRows.length > 0
      ? ` 当前计划：${plannedStakeRows.map((row) => row.detail).join("；")}。`
      : "";
    return {
      badge: "日常模板",
      factValue: "日常固定模板白名单",
      factDetail: "只展示日常固定模板；最终可买题目、outcome、金额和时间由 Bot4 planned-buy 决定。",
      stage: {
        title: "固定模板白名单",
        detail: "只处理 Bot4 买入题目白名单内的日常模板，其他模板仅展示和通知。",
        meta: ["题目白名单", "计划驱动", "其他模板只观察"]
      },
      selectionStage: {
        title: "计划指定 outcome",
        detail: `全局回退为 ${fallbackSelection.title}；实际 planned-buy 可以覆盖每个 outcome 的金额与批次上限。${plannedStakeDetail}`,
        meta: plannedStakeRows.length > 0
          ? plannedStakeRows.map((row) => row.meta)
          : [`默认上限 ${formatNumber(maxMarketStake)}U`, "named selection", "计划优先"]
      }
    };
  }

  const focusTitle = focusEnabled ? "Meme / Binance strong" : "手动关注 / planned-buy";
  const focusDetail = focusEnabled
    ? "Meme 分类直接通过；非 Meme 事件只有 Binance strong 才默认买入。Price、固定模板和低流动性题材先排除。"
    : "没有默认情报买入范围；只有手动关注或 planned-buy 允许执行。";
  const bot2Specific = kind === "bot2"
    ? "Meme 包括 Meme 元数据、$TOKEN FDV 和已配置中文 Meme 题材。"
    : kind === "bot5"
      ? "沿用 Bot2-like 的 Meme/Binance strong 判断，但钱包、RPC 和状态完全独立。"
      : "默认情报过滤与 planned-buy 同时存在，planned-buy 始终优先。";
  const memeRangeSelectionEnabled = Boolean(cfg.memeRangeSelectionEnabled) && (kind === "bot2" || kind === "bot5");
  const memeOutcomeCount = Math.max(1, Number(cfg.memeRangeSelectionOutcomeCount ?? 3));
  const memeRadius = Math.floor(memeOutcomeCount / 2);
  const selectionStage = memeRangeSelectionEnabled
    ? {
        title: `Meme 智能 ${formatNumber(memeOutcomeCount)} 项 x ${formatNumber(fallbackSelection.stake)}U`,
        detail: `Meme FDV/价格区间在首次监控时锁定当前档，执行时选择上下各 ${formatNumber(memeRadius)} 档；来源或区间不可用时买中间 ${formatNumber(memeOutcomeCount)} 项。非 Meme 的 Binance strong 仍按 ${fallbackSelection.title}。单场上限 ${formatNumber(maxMarketStake)}U。`,
        meta: ["首次监控锁定", `当前档 +/- ${formatNumber(memeRadius)}`, `失败回退中间 ${formatNumber(memeOutcomeCount)} 项`]
      }
    : {
        title: fallbackSelection.title,
        detail: `${fallbackSelection.detail} 单场上限 ${formatNumber(maxMarketStake)}U。`,
        meta: [`${formatNumber(fallbackSelection.stake)}U/项`, `单场 ${formatNumber(fallbackSelection.totalStake)}U`, "计划配置优先"]
      };
  return {
    badge: focusEnabled ? "Meme / Binance" : "计划买入",
    factValue: focusTitle,
    factDetail: `${focusDetail} ${bot2Specific}`,
    stage: {
      title: focusTitle,
      detail: focusDetail,
      meta: focusEnabled ? ["Meme 默认关注", "Binance strong", "Price/模板排除"] : ["手动关注", "planned-buy", "默认不追单"]
    },
    selectionStage
  };
}

function selectionPolicy(cfg, watch) {
  const strategy = String(watch.eventOutcomeSelection ?? cfg.eventOutcomeSelection ?? "lowest_odds");
  const count = Math.max(1, Math.trunc(numeric(watch.eventOutcomeCount ?? cfg.eventOutcomeCount, 1)));
  const stake = numeric(watch.stakePerOutcomeUsdt ?? cfg.stakePerOutcomeUsdt, 0);
  const totalStake = count * stake;
  const labels = {
    first: `前 ${count} 项 x ${formatNumber(stake)}U`,
    middle: `中间 ${count} 项 x ${formatNumber(stake)}U`,
    lowest_odds: `最低赔率 ${count} 项 x ${formatNumber(stake)}U`,
    all: `全部 outcome x ${formatNumber(stake)}U`,
    names: `指定 ${count} 项 x ${formatNumber(stake)}U`
  };
  const details = {
    first: "按 tokenId/展示顺序取最前面的 outcome，不做赔率预测。",
    middle: "按 tokenId/展示顺序取中间 outcome，不做足球或价格预测。",
    lowest_odds: "按有效赔率排序；缺失时按 profile 的 fallback 规则处理。",
    all: "买入市场中的全部可用 outcome。",
    names: "按 profile 或 planned-buy 指定的 outcome 名称买入。"
  };
  return {
    strategy,
    count,
    stake,
    totalStake,
    title: labels[strategy] ?? `${count} 项 x ${formatNumber(stake)}U`,
    detail: details[strategy] ?? "按当前 profile 的 outcome 规则选择。"
  };
}

function executionPolicy(kind, cfg, watch) {
  const bot4Policy = kind === "bot4" ? bot4PlannedExecutionPolicy(cfg, watch) : null;
  if (bot4Policy) return bot4Policy;
  const builder = watch.builderBundle ?? {};
  const enabled = Boolean(builder.enabled ?? cfg.builderBundleEnabled);
  const gas = String(watch.gasPriceGwei ?? cfg.gasPriceGwei ?? "--");
  const openDelayMs = numeric(watch.openBroadcastDelayMs ?? cfg.openBroadcastDelayMs, 0);
  const rpcCount = Math.max(0, Math.trunc(numeric(watch.broadcastRpcCount ?? cfg.broadcastRpcUrls?.length, 0)));
  if (!enabled) {
    const plannedOverride = kind === "bot4"
      ? "Bot4 planned-buy 可以单独启用 Builder 或覆盖广播时间。"
      : "事件级 planned-buy 可以覆盖执行通道。";
    return {
      badge: "RPC",
      tone: "rpc",
      mode: "rpc",
      factDetail: `全局 Builder 关闭；${plannedOverride}`,
      stage: {
        title: `RPC · T+${formatOffsetMs(openDelayMs)}`,
        detail: `${rpcCount || 1} 路执行 RPC，买入 Gas ${gas} gwei。${plannedOverride}`,
        meta: [`买入 ${gas} gwei`, `${rpcCount || 1} 路 RPC`, "Builder 默认关闭"]
      }
    };
  }

  const mode = String(builder.mode ?? cfg.builderBundleMode ?? "concurrent");
  const targetSecond = Math.trunc(numeric(builder.targetSecond, inferTargetSecond(builder.timingMode ?? cfg.builderBundleTimingMode, openDelayMs)));
  const earlySubmitOffsetMs = numeric(
    builder.earlySubmitOffsetMs,
    targetSecond * 1000 - numeric(builder.targetBoundaryLeadMs ?? cfg.builderBundlePrepositionLeadMs, 0)
  );
  const tip = String(builder.tipBnb ?? cfg.builderBundleTipBnb ?? "0");
  const providerCount = Array.isArray(builder.builders)
    ? builder.builders.filter((item) => item?.enabled).length
    : (cfg.blockrazorBuilderEnabled ? 2 : 1);
  const strict = mode === "builder_only";
  const flags = [
    (builder.positionFirst ?? cfg.builderBundlePositionFirst) ? "positionFirst" : null,
    (builder.noMerge ?? cfg.builderBundleNoMerge) ? "noMerge" : null
  ].filter(Boolean);
  return {
    badge: strict ? `Builder T+${targetSecond}` : "Builder + RPC",
    tone: "builder",
    mode,
    factDetail: strict
      ? `T+${formatOffsetMs(earlySubmitOffsetMs)} 私有提交；Builder 未接受或错过目标秒就放弃，不公开广播。`
      : `T+${formatOffsetMs(earlySubmitOffsetMs)} 私有提交，按 ${mode} 规则处理 RPC fallback。`,
    stage: {
      title: `${providerCount > 1 ? "双 Builder" : "Builder"} · T+${targetSecond}`,
      detail: strict
        ? `T+${formatOffsetMs(earlySubmitOffsetMs)} 提交原子买入，链上时间门槛只允许目标秒成交；失败不公开追单。`
        : `先向 Builder 提交，再按 ${mode} 配置决定是否使用公共 RPC。`,
      meta: [`买入 ${gas} gwei`, `TIP ${tip} BNB`, strict ? "无公共 fallback" : "可 RPC fallback", ...flags]
    }
  };
}

function bot4PlannedExecutionPolicy(cfg, watch) {
  const plans = Array.isArray(watch.plannedBuyPlans)
    ? watch.plannedBuyPlans.filter((plan) => plan?.enabled)
    : [];
  if (plans.length === 0) return null;
  const openRouter = plans.find((plan) => /openrouter/iu.test(`${plan?.id ?? ""} ${plan?.question ?? ""} ${plan?.questionRegex ?? ""}`));
  const bnb = plans.find((plan) => /bnb.*usdt|bnbusdt/iu.test(`${plan?.id ?? ""} ${plan?.question ?? ""} ${plan?.questionRegex ?? ""}`));
  if (!openRouter && !bnb) return null;

  const rows = [
    openRouter ? summarizeBot4PlannedExecution("OpenRouter", openRouter, cfg) : null,
    bnb ? summarizeBot4PlannedExecution("BNB/USDT", bnb, cfg) : null
  ].filter(Boolean);
  const primary = rows.find((row) => row.builder) ?? rows[0];
  const detail = rows.map((row) => row.detail).join("；");
  return {
    badge: primary.builder ? `Builder T+${primary.targetSecond}` : "计划通道",
    tone: primary.builder ? "builder" : "rpc",
    mode: rows.length > 1 ? "planned_mixed" : primary.mode,
    factDetail: `${detail}。每个事件只使用自己的 planned-buy 通道。`,
    stage: {
      title: primary.builder
        ? `${primary.providerCount > 1 ? "双 Builder" : "Builder"} · T+${primary.targetSecond}`
        : `${primary.label} RPC · T+${formatOffsetMs(primary.delayMs)}`,
      detail: `${detail}。`,
      meta: rows.map((row) => row.meta)
    }
  };
}

function bot4PlannedStakeRows(plans) {
  return (Array.isArray(plans) ? plans : [])
    .filter((plan) => plan?.enabled && Array.isArray(plan?.outcomes) && plan.outcomes.length > 0)
    .map((plan) => {
      const fallback = numeric(plan.stakePerOutcomeUsdt, 0);
      const stakes = plan.outcomes.map((outcome) => ({
        outcome,
        stake: numeric(plan.stakeByOutcomeUsdt?.[outcome], fallback)
      }));
      const label = /openrouter/iu.test(`${plan.id ?? ""} ${plan.question ?? ""} ${plan.questionRegex ?? ""}`)
        ? "OpenRouter"
        : /bnb.*usdt|bnbusdt/iu.test(`${plan.id ?? ""} ${plan.question ?? ""} ${plan.questionRegex ?? ""}`)
          ? "BNB/USDT"
          : String(plan.id ?? "计划");
      const total = stakes.reduce((sum, row) => sum + row.stake, 0);
      return {
        detail: `${label}：${stakes.map((row) => `${row.outcome} ${formatNumber(row.stake)}U`).join("、")}`,
        meta: `${label} · ${formatNumber(total)}U`
      };
    });
}

function summarizeBot4PlannedExecution(label, plan, cfg) {
  const builder = plan.builderBundle ?? {};
  const builderEnabled = builder.enabled === true;
  const delayMs = numeric(plan.openBroadcastDelayMs, cfg.openBroadcastDelayMs ?? 0);
  const gas = formatNumber(plan.gasPriceGwei ?? cfg.gasPriceGwei ?? "--");
  if (!builderEnabled) {
    return {
      label,
      builder: false,
      mode: "rpc",
      delayMs,
      detail: `${label} 使用 RPC T+${formatOffsetMs(delayMs)}，买入 Gas ${gas} gwei`,
      meta: `${label} · RPC T+${formatOffsetMs(delayMs)}`
    };
  }
  const targetSecond = inferTargetSecond(builder.timingMode, delayMs);
  const prepositionLeadMs = numeric(builder.prepositionLeadMs, cfg.builderBundlePrepositionLeadMs ?? 0);
  const earlySubmitMs = targetSecond * 1000 - prepositionLeadMs;
  const providerCount = cfg.blockrazorBuilderEnabled ? 2 : 1;
  const strict = builder.mode === "builder_only";
  return {
    label,
    builder: true,
    mode: builder.mode,
    targetSecond,
    providerCount,
    delayMs,
    detail: `${label} 使用${providerCount > 1 ? "双 Builder" : " Builder"} T+${targetSecond}，T+${formatOffsetMs(earlySubmitMs)} 私有提交，买入 Gas ${gas} gwei，TIP ${builder.tipBnb ?? cfg.builderBundleTipBnb ?? "0"} BNB${strict ? "，无公共 fallback" : ""}`,
    meta: `${label} · ${providerCount > 1 ? "双 Builder" : "Builder"} T+${targetSecond}`
  };
}

function exitPolicy(kind, cfg, watch) {
  const enabled = Boolean(watch.autoSellEnabled ?? cfg.autoSellEnabled);
  const mode = String(watch.autoSellStrategy ?? cfg.autoSellStrategy ?? "legacy");
  const sellGas = String(watch.autoSellGasPriceGwei ?? cfg.autoSellGasPriceGwei ?? cfg.gasPriceGwei ?? "--");
  if (!enabled) {
    return {
      mode,
      modeLabel: "自动卖出关闭",
      tone: "neutral",
      factDetail: "持仓不会由主 worker 自动退出；事件级监控卖出仍按各自服务配置执行。",
      stage: { title: "自动卖出关闭", detail: "主 worker 不执行自动卖出。", meta: [`卖出 Gas ${sellGas} gwei`] }
    };
  }

  const bot4PricePlan = kind === "bot4"
    ? (watch.plannedBuyPlans ?? []).find((plan) => (
        plan?.enabled && Array.isArray(plan?.autoSell?.priceTargets) && plan.autoSell.priceTargets.some((target) => target?.enabled !== false)
      ))
    : null;
  if (mode === "open_timed_exit" && bot4PricePlan) {
    const targets = bot4PricePlan.autoSell.priceTargets.filter((target) => target?.enabled !== false);
    const targetText = targets.map((target) => `${target.outcome} $${formatNumber(target.price)}`).join("；");
    const hotPollMs = numeric(bot4PricePlan.autoSell.priceHotPollMs, 1000);
    const hotWindowSeconds = numeric(bot4PricePlan.autoSell.priceHotWindowSeconds, 600);
    const normalPollMs = numeric(watch.autoSellPollMs ?? cfg.autoSellPollMs, 60000);
    return {
      mode: "rest_price_target",
      modeLabel: "REST 价格阈值退出",
      tone: "exit",
      factDetail: `${targetText}。买后 ${formatDurationSeconds(hotWindowSeconds)} 每 ${formatDurationSeconds(hotPollMs / 1000)} 检查，之后每 ${formatDurationSeconds(normalPollMs / 1000)}；19:00 清剩余，卖出 Gas ${sellGas} gwei。`,
      stage: {
        title: "价格阈值卖出 + 19:00清仓",
        detail: `${targetText}。达到对应 42 REST curPrice 后卖出该 outcome 100%。`,
        meta: [`REST ${formatDurationSeconds(hotPollMs / 1000)}`, `热区 ${formatDurationSeconds(hotWindowSeconds)}`, `卖出 ${sellGas} gwei`]
      }
    };
  }

  if (mode === "open_timed_exit") {
    const delay = numeric(watch.autoSellOpenExitDelaySeconds ?? cfg.autoSellOpenExitDelaySeconds, 36);
    const percent = numeric(watch.autoSellOpenExitPercent ?? cfg.autoSellOpenExitPercent, 100);
    const fastEnabled = Boolean(watch.autoSellFastOpenExitEnabled ?? cfg.autoSellFastOpenExitEnabled);
    const fastMin = numeric(watch.autoSellFastOpenExitMinDelayMs ?? cfg.autoSellFastOpenExitMinDelayMs, 0);
    const fastMax = numeric(watch.autoSellFastOpenExitMaxDelayMs ?? cfg.autoSellFastOpenExitMaxDelayMs, 0);
    const fastText = fastEnabled
      ? `成交确认后准备快速退出，目标窗口 T+${formatOffsetMs(fastMin)} 至 T+${formatOffsetMs(fastMax)}。`
      : "不启用随机快速退出窗口。";
    return {
      mode,
      modeLabel: "开盘定时退出",
      tone: "exit",
      factDetail: `${fastText} 卖出 Gas ${sellGas} gwei。`,
      stage: {
        title: `开盘后 ${formatDurationSeconds(delay)} 卖 ${formatNumber(percent)}%`,
        detail: fastText,
        meta: [`卖出 ${sellGas} gwei`, fastEnabled ? `快速 ${formatOffsetMs(fastMin)}-${formatOffsetMs(fastMax)}` : "固定时间", `${formatNumber(percent)}% 退出`]
      }
    };
  }

  if (mode === "pre_start_exit") {
    const beforeStart = numeric(watch.autoSellBeforeMarketStartSeconds ?? cfg.autoSellBeforeMarketStartSeconds, 0);
    const retain = isExactScoreStrategy(cfg, kind)
      ? "事件级 retainPositions 可以保留指定比例至结算。"
      : "事件级 hold_to_settlement 可以覆盖清仓。";
    return {
      mode,
      modeLabel: "赛前退出",
      tone: "exit",
      factDetail: `平时持有，不按固定秒数分批卖出。${retain} 卖出 Gas ${sellGas} gwei。`,
      stage: {
        title: beforeStart > 0 ? `赛前 ${formatDurationSeconds(beforeStart)} 清仓` : "赛前清仓时间未配置",
        detail: `持仓等待到比赛前退出；${retain}`,
        meta: [`卖出 ${sellGas} gwei`, "不做固定间隔分批", isExactScoreStrategy(cfg, kind) ? "支持指定留仓" : "计划可持有至结算"]
      }
    };
  }

  if (mode === "ladder") {
    const delay = numeric(watch.autoSellStartDelaySeconds ?? cfg.autoSellStartDelaySeconds, 0);
    const interval = numeric(watch.autoSellIntervalSeconds ?? cfg.autoSellIntervalSeconds, 10);
    const chunk = numeric(watch.autoSellChunkPercent ?? cfg.autoSellChunkPercent, 10);
    const profit = numeric(watch.autoSellLadderProfitPercent ?? cfg.autoSellLadderProfitPercent, 0);
    const steps = Math.trunc(numeric(watch.autoSellTakeProfitSteps ?? cfg.autoSellTakeProfitSteps, 0));
    const gate = profit > 0 ? `盈利 ${formatNumber(profit)}% 后` : `${formatDurationSeconds(delay)} 后`;
    const cadence = steps > 0 ? `卖 ${formatNumber(chunk)}%，共 ${steps} 次` : `每 ${formatDurationSeconds(interval)} 卖 ${formatNumber(chunk)}%`;
    return {
      mode,
      modeLabel: "阶梯卖出",
      tone: "exit",
      factDetail: `${gate}${cadence}；卖出 Gas ${sellGas} gwei。`,
      stage: {
        title: `${gate}${cadence}`,
        detail: "只有 ladder 模式才使用延迟、间隔和每次卖出比例。",
        meta: [`卖出 ${sellGas} gwei`, profit > 0 ? `盈利门槛 ${formatNumber(profit)}%` : `延迟 ${formatDurationSeconds(delay)}`, steps > 0 ? `${steps} 次` : `间隔 ${formatDurationSeconds(interval)}`]
      }
    };
  }

  const multiplier = numeric(watch.autoSellProfitMultiplier ?? cfg.autoSellProfitMultiplier, 2);
  const percent = numeric(watch.autoSellPercent ?? cfg.autoSellPercent, 50);
  return {
    mode,
    modeLabel: "Legacy",
    tone: "exit",
    factDetail: `达到 ${formatNumber(multiplier)}x 后卖 ${formatNumber(percent)}%；卖出 Gas ${sellGas} gwei。`,
    stage: {
      title: `${formatNumber(multiplier)}x 卖 ${formatNumber(percent)}%`,
      detail: "Legacy 倍数止盈模式。",
      meta: [`卖出 ${sellGas} gwei`, "Legacy"]
    }
  };
}

function stopLossText(cfg, watch) {
  const enabled = Boolean(watch.autoSellStopLossEnabled ?? cfg.autoSellStopLossEnabled);
  if (!enabled) {
    return { enabled: false, text: "关闭", detail: "主 worker 不执行价格止损；事件级监控卖出不受此字段代表。" };
  }
  const percent = numeric(watch.autoSellStopLossPercent ?? cfg.autoSellStopLossPercent, 10);
  const sellPercent = numeric(watch.autoSellStopLossSellPercent ?? cfg.autoSellStopLossSellPercent, 100);
  const action = sellPercent >= 100 ? "全卖" : `卖 ${formatNumber(sellPercent)}%`;
  return {
    enabled: true,
    text: `亏 ${formatNumber(percent)}% ${action}`,
    detail: "止损与主退出策略并行，触发后按配置比例卖出。"
  };
}

function plannedPriorityText(kind, cfg = {}) {
  if (isExactScoreStrategy(cfg, kind)) {
    return "事件级 planned-buy 优先覆盖 outcome、金额、Gas、目标秒、Builder 和卖出策略；retainPositions 只对明确列出的 outcome 生效。";
  }
  if (kind === "bot4") {
    return "Bot4 以 planned-buy 为主：事件记录可以覆盖 outcome、金额、Gas、时间、Builder 和卖出策略；未命中买入白名单的模板只展示。";
  }
  return "事件级 planned-buy 可以覆盖 outcome、金额、Gas、目标时间、Builder 和卖出策略；手动取消关注仍会阻止普通自动买入。";
}

function profileSummary(kind, buy, execution, exit) {
  if (kind === "bot2") {
    return `${buy.selectionStage.title}，${execution.stage.title}，${exit.stage.title}。`;
  }
  if (kind === "bot3") {
    return `自动选择低价胜方的 5 个标准比分，${execution.stage.title}，${exit.stage.title}。`;
  }
  if (kind === "bot4") {
    return `日常模板由 planned-buy 分流执行，${execution.stage.title}，${exit.stage.title}。`;
  }
  if (kind === "bot5") {
    return `独立执行 Bot2-like 事件策略，${buy.selectionStage.title}，${exit.stage.title}。`;
  }
  if (buy.badge === "精确比分") {
    return `自动选择低价胜方的 5 个标准比分，${execution.stage.title}，${exit.stage.title}。`;
  }
  return `${buy.stage.title}，${buy.selectionStage.title}，${exit.stage.title}。`;
}

function isExactScoreStrategy(cfg = {}, kind = dashboardProfileKind(cfg)) {
  const role = String(cfg.profileRole ?? "").trim().toLowerCase().replace(/[-\s]+/gu, "_");
  return kind === "bot3" || role === "bot3_like";
}

function inferTargetSecond(mode, openDelayMs) {
  if (mode === "first_19s_block") return 19;
  if (mode === "first_20s_block") return 20;
  const inferred = Math.round(numeric(openDelayMs, 0) / 1000);
  return inferred > 0 ? inferred : 19;
}

function formatOffsetMs(value) {
  const ms = numeric(value, 0);
  return `${formatNumber(ms / 1000, 3)}s`;
}

function formatDurationSeconds(value) {
  const seconds = numeric(value, 0);
  if (seconds >= 3600 && seconds % 3600 === 0) return `${formatNumber(seconds / 3600)}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${formatNumber(seconds / 60)}min`;
  return `${formatNumber(seconds, 3)}s`;
}

function formatNumber(value, maxDecimals = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "--");
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(maxDecimals).replace(/0+$/u, "").replace(/\.$/u, "");
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function runDashboardStrategySelfTest() {
  const base = {
    dryRun: false,
    execute: true,
    eventIntelBuyFilter: "strong",
    eventOutcomeSelection: "first",
    eventOutcomeCount: 3,
    stakePerOutcomeUsdt: 10,
    maxMarketStakeUsdt: 30,
    gasPriceGwei: "1.1",
    autoSellEnabled: true,
    autoSellGasPriceGwei: "0.15",
    autoSellStopLossPercent: 10,
    autoSellStopLossSellPercent: 100
  };
  const bot2 = buildDashboardStrategyProfile({
    ...base,
    botName: "Bot2 Console",
    builderBundleEnabled: true,
    builderBundleMode: "builder_only",
    builderBundleTimingMode: "first_19s_block",
    builderBundlePrepositionLeadMs: 500,
    builderBundleTipBnb: "0.001",
    blockrazorBuilderEnabled: true,
    memeRangeSelectionEnabled: true,
    memeRangeSelectionOutcomeCount: 5,
    autoSellStrategy: "open_timed_exit",
    autoSellOpenExitDelaySeconds: 25,
    autoSellOpenExitPercent: 100,
    autoSellFastOpenExitEnabled: true,
    autoSellFastOpenExitMinDelayMs: 24500,
    autoSellFastOpenExitMaxDelayMs: 26000,
    autoSellStopLossEnabled: true
  }, {
    builderBundle: { enabled: true, mode: "builder_only", targetSecond: 19, earlySubmitOffsetMs: 18500, tipBnb: "0.001", builders: [{ enabled: true }, { enabled: true }] }
  });
  assert(bot2.kind === "bot2", "Bot2 profile kind");
  assert(bot2.stages[1].title === "Meme 智能 5 项 x 10U", "Bot2 Meme range selection");
  assert(bot2.stages[2].title === "双 Builder · T+19", "Bot2 builder target");
  assert(bot2.stages[3].title === "开盘后 25s 卖 100%", "Bot2 exit");

  const bot5 = buildDashboardStrategyProfile({
    ...base,
    botName: "42space-5",
    eventOutcomeSelection: "middle",
    builderBundleEnabled: true,
    builderBundleMode: "builder_only",
    builderBundleTimingMode: "first_20s_block",
    builderBundlePrepositionLeadMs: 500,
    builderBundleTipBnb: "0.001",
    blockrazorBuilderEnabled: true,
    memeRangeSelectionEnabled: true,
    autoSellStrategy: "open_timed_exit",
    autoSellOpenExitDelaySeconds: 40,
    autoSellOpenExitPercent: 100,
    autoSellFastOpenExitEnabled: true,
    autoSellFastOpenExitMinDelayMs: 40000,
    autoSellFastOpenExitMaxDelayMs: 50000,
    autoSellStopLossEnabled: true
  }, {
    builderBundle: { enabled: true, mode: "builder_only", targetSecond: 20, earlySubmitOffsetMs: 19500, tipBnb: "0.001", builders: [{ enabled: true }, { enabled: true }] }
  });
  assert(bot5.kind === "bot5", "Bot5 profile kind");
  assert(bot5.stages[1].title === "Meme 智能 3 项 x 10U", "Bot5 Meme range selection");
  assert(bot5.stages[2].title === "双 Builder · T+20", "Bot5 builder target");
  assert(bot5.stages[3].title === "开盘后 40s 卖 100%", "Bot5 exit base delay");
  assert(bot5.stages[3].detail.includes("T+40") && bot5.stages[3].detail.includes("T+50"), "Bot5 randomized exit window");

  const bot3 = buildDashboardStrategyProfile({
    ...base,
    botName: "Bot3 Exact Score Console",
    bot3FifaExactScoreAutoBuyEnabled: true,
    bot3FifaExactScoreAutoStakeUsdt: 10,
    autoSellStrategy: "pre_start_exit",
    autoSellBeforeMarketStartSeconds: 36000,
    autoSellStopLossEnabled: false
  });
  assert(bot3.kind === "bot3", "Bot3 profile kind");
  assert(bot3.stages[1].title === "胜方 5 项 x 10U", "Bot3 exact-score selection");
  assert(bot3.stages[3].title === "赛前 10h 清仓", "Bot3 pre-start exit");

  const bot1ExactScore = buildDashboardStrategyProfile({
    ...base,
    botName: "Bot1 Console",
    profileRole: "bot3_like",
    eventIntelBuyFilter: "off",
    bot3FifaExactScoreAutoBuyEnabled: true,
    bot3FifaExactScoreAutoStakeUsdt: 10,
    builderBundleEnabled: true,
    builderBundleMode: "builder_only",
    builderBundleTimingMode: "first_20s_block",
    builderBundlePrepositionLeadMs: 500,
    builderBundleTipBnb: "0.001",
    blockrazorBuilderEnabled: true,
    autoSellStrategy: "pre_start_exit",
    autoSellBeforeMarketStartSeconds: 36000,
    autoSellStopLossEnabled: false
  });
  assert(bot1ExactScore.kind === "bot1", "Bot1 exact-score keeps Bot1 identity");
  assert(bot1ExactScore.title === "FIFA 精确比分自动买入", "Bot1 exact-score title");
  assert(bot1ExactScore.stages[1].title === "胜方 5 项 x 10U", "Bot1 copies Bot3 exact-score selection");
  assert(bot1ExactScore.stages[2].title === "双 Builder · T+20", "Bot1 keeps T+20 builder target");
  assert(bot1ExactScore.stages[3].meta.includes("支持指定留仓"), "Bot1 copies Bot3 retain-position semantics");

  const bot4 = buildDashboardStrategyProfile({
    ...base,
    botName: "42space-4",
    eventIntelBuyFilter: "off",
    eventOutcomeSelection: "names",
    eventOutcomeCount: 1,
    stakePerOutcomeUsdt: 5,
    builderBundleEnabled: false,
    openBroadcastDelayMs: 19900,
    autoSellStrategy: "open_timed_exit",
    autoSellOpenExitDelaySeconds: 39600,
    autoSellStopLossEnabled: false,
    blockrazorBuilderEnabled: true
  }, {
    plannedBuyPlans: [
      {
        id: "bot4-openrouter-python-daily",
        enabled: true,
        outcomes: ["Hy3 (free)", "MiMo - V2.5"],
        stakePerOutcomeUsdt: 10,
        stakeByOutcomeUsdt: { "Hy3 (free)": 20 },
        openBroadcastDelayMs: 19900,
        gasPriceGwei: 0.5,
        builderBundle: {
          enabled: true,
          mode: "builder_only",
          timingMode: "first_20s_block",
          tipBnb: "0.001",
          prepositionLeadMs: 500
        },
        autoSell: {
          priceTargets: [
            { outcome: "Hy3 (free)", price: 0.002, enabled: true },
            { outcome: "MiMo - V2.5", price: 0.0017, enabled: true }
          ],
          priceHotPollMs: 1000,
          priceHotWindowSeconds: 600
        }
      },
      {
        id: "bot4-bnbusdt-daily-volume",
        enabled: true,
        outcomes: ["$150M - $300M", "$300M - $450M"],
        stakePerOutcomeUsdt: 10,
        openBroadcastDelayMs: 22000,
        gasPriceGwei: 0.15,
        builderBundle: null
      }
    ]
  });
  assert(bot4.kind === "bot4", "Bot4 profile kind");
  assert(bot4.stages[0].title === "固定模板白名单", "Bot4 scope");
  assert(bot4.stages[1].detail.includes("Hy3 (free) 20U"), "Bot4 outcome-specific stake detail");
  assert(bot4.stages[2].title === "双 Builder · T+20", "Bot4 OpenRouter planned execution");
  assert(bot4.stages[3].title === "价格阈值卖出 + 19:00清仓", "Bot4 price exit");
  assert(bot4.stages[3].detail.includes("MiMo - V2.5 $0.0017"), "Bot4 price target detail");

  const kinds = ["bot1", "bot2", "bot3", "bot4", "bot5"];
  for (const kind of kinds) assert(PROFILE_KINDS.has(kind), `known profile ${kind}`);
  return { passed: 23, profiles: kinds };
}

function assert(condition, label) {
  if (!condition) throw new Error(`Dashboard strategy self-test failed: ${label}`);
}
