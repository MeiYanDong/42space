const ROUTES = {
  overview: {
    kicker: "Today",
    title: "Overview",
    lead: "判断当前 bot 是否需要人工干预。"
  },
  markets: {
    kicker: "Discovery",
    title: "即将开盘",
    lead: "按时长、类别和开盘时间筛选；关注即允许买入，取消关注即禁止买入。"
  },
  positions: {
    kicker: "Portfolio",
    title: "项目持仓",
    lead: "查看默认关注、手动关注、当前持仓和全部卖出后的历史项目。"
  },
  execution: {
    kicker: "Audit",
    title: "Execution",
    lead: "复盘链上活动、本地执行结果和失败原因。"
  },
  watchlist: {
    kicker: "Address Watch",
    title: "地址监控",
    lead: "查看关注地址的 watcher 状态、最近交易和对应的 42 事件。"
  },
  strategy: {
    kicker: "Profile Policy",
    title: "策略",
    lead: "当前 Bot 的买入、执行、退出与事件级覆盖规则。"
  }
};

const state = {
  data: null,
  route: routeFromHash(),
  upcomingHorizonDays: 7,
  durationFilter: "all",
  categoryFilter: "all",
  selectedUpcomingMarkets: new Set(),
  visibleUpcomingMarkets: [],
  upcomingBulkBusy: false,
  expandedMarkets: new Set(),
  marketDetails: new Map(),
  projectExpanded: new Set(),
  historyExpanded: new Set(),
  showHistoryProjects: false,
  selected: null,
  sellPercent: 100,
  quoteRequest: 0,
  quoteTimer: null,
  configDirty: false,
  runtimeConfig: null,
  runtimeWriteProtected: false,
  priceExitPayload: null,
  priceExitDraft: [],
  priceExitDirty: false,
  priceExitWriteProtected: false,
  orderflowPayload: null,
  orderflowWriteProtected: false,
  watchedAddressPayload: null,
  watchedAddressLookbackMinutes: 60,
  watchedAddressLoading: false,
  automationStatus: null,
  timer: null,
  automationTimer: null
};
const overviewRefreshMs = 60000;
const automationRefreshMs = 10000;

const ICONS = {
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>`,
  "badge-dollar-sign": `<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"></path><path d="M12 7v10"></path><path d="M15 9.5A3.5 3.5 0 0 0 12 8a2.5 2.5 0 0 0 0 5 2.5 2.5 0 0 1 0 5 3.5 3.5 0 0 1-3-1.5"></path>`,
  "bar-chart-3": `<path d="M3 3v18h18"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path>`,
  "calendar-clock": `<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"></path><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h5"></path><circle cx="16" cy="16" r="6"></circle><path d="M16 14v2l1.5 1.5"></path>`,
  "check-square": `<path d="m9 11 3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"></path>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"></path>`,
  "circle-dollar-sign": `<circle cx="12" cy="12" r="10"></circle><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"></path><path d="M12 18V6"></path>`,
  plus: `<path d="M12 5v14"></path><path d="M5 12h14"></path>`,
  "trash-2": `<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>`,
  bookmark: `<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"></path>`,
  "bookmark-x": `<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z"></path><path d="m14.5 7.5-5 5"></path><path d="m9.5 7.5 5 5"></path>`,
  clock: `<circle cx="12" cy="12" r="10"></circle><path d="M12 6v6l4 2"></path>`,
  "loader-circle": `<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>`,
  "layers-3": `<path d="m12 2 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5"></path><path d="m3 17 9 5 9-5"></path>`,
  radio: `<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2a6 6 0 0 1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8a6 6 0 0 1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>`,
  receipt: `<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1Z"></path><path d="M16 8h-6"></path><path d="M16 12h-6"></path><path d="M10 16h4"></path>`,
  "refresh-cw": `<path d="M3 12a9 9 0 0 1 15.2-6.4L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.2 6.4L3 16"></path><path d="M3 21v-5h5"></path>`,
  send: `<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>`,
  "sliders-horizontal": `<line x1="21" x2="14" y1="4" y2="4"></line><line x1="10" x2="3" y1="4" y2="4"></line><line x1="21" x2="12" y1="12" y2="12"></line><line x1="8" x2="3" y1="12" y2="12"></line><line x1="21" x2="16" y1="20" y2="20"></line><line x1="12" x2="3" y1="20" y2="20"></line><line x1="14" x2="14" y1="2" y2="6"></line><line x1="8" x2="8" y1="10" y2="14"></line><line x1="16" x2="16" y1="18" y2="22"></line>`,
  sparkles: `<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"></path><path d="M5 3v4"></path><path d="M19 17v4"></path><path d="M3 5h4"></path><path d="M17 19h4"></path>`,
  timer: `<line x1="10" x2="14" y1="2" y2="2"></line><line x1="12" x2="15" y1="14" y2="11"></line><circle cx="12" cy="14" r="8"></circle>`,
  "trending-up": `<path d="m22 7-8.5 8.5-5-5L2 17"></path><path d="M16 7h6v6"></path>`,
  wallet: `<path d="M20 12V8H6a2 2 0 0 1 0-4h12v4"></path><path d="M4 6v12a2 2 0 0 0 2 2h14v-4"></path><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"></path>`,
  x: `<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>`
};

const $ = (id) => document.getElementById(id);

const els = {
  updated: $("updated"),
  appTitle: $("appTitle"),
  refreshBtn: $("refreshBtn"),
  viewKicker: $("viewKicker"),
  viewTitle: $("viewTitle"),
  viewLead: $("viewLead"),
  botState: $("botState"),
  fundingState: $("fundingState"),
  nextClock: $("nextClock"),
  newMarketCount: $("newMarketCount"),
  newMarketList: $("newMarketList"),
  selectAllUpcoming: $("selectAllUpcoming"),
  bulkFollowUpcoming: $("bulkFollowUpcoming"),
  bulkBlockUpcoming: $("bulkBlockUpcoming"),
  upcomingSelectedCount: $("upcomingSelectedCount"),
  nextCount: $("nextCount"),
  upcomingList: $("upcomingList"),
  upcomingCategoryFilter: $("upcomingCategoryFilter"),
  positionSummary: $("positionSummary"),
  aggregatePnlPanel: $("aggregatePnlPanel"),
  projectBoardCount: $("projectBoardCount"),
  projectBoardList: $("projectBoardList"),
  toggleHistoryProjects: $("toggleHistoryProjects"),
  historyProjectList: $("historyProjectList"),
  activityList: $("activityList"),
  attentionList: $("attentionList"),
  overviewSnapshot: $("overviewSnapshot"),
  overviewNextAction: $("overviewNextAction"),
  overviewActivityMini: $("overviewActivityMini"),
  strategyProfileEyebrow: $("strategyProfileEyebrow"),
  strategyProfileTitle: $("strategyProfileTitle"),
  strategyProfileSummary: $("strategyProfileSummary"),
  strategyProfileBadges: $("strategyProfileBadges"),
  strategyFlow: $("strategyFlow"),
  strategyFacts: $("strategyFacts"),
  automationRuntimeGrid: $("automationRuntimeGrid"),
  automationRuntimeUpdated: $("automationRuntimeUpdated"),
  strategyOverrideText: $("strategyOverrideText"),
  strategyAdvancedConfig: $("strategyAdvancedConfig"),
  ruleFilterText: $("ruleFilterText"),
  ruleDisplayText: $("ruleDisplayText"),
  ruleFollowText: $("ruleFollowText"),
  ruleNotifyText: $("ruleNotifyText"),
  preflightList: $("preflightList"),
  runtimeConfigForm: $("runtimeConfigForm"),
  configMode: $("configMode"),
  configDisplayFilters: $("configDisplayFilters"),
  configOutcomeCount: $("configOutcomeCount"),
  configStakePerOutcome: $("configStakePerOutcome"),
  configMaxBatchStake: $("configMaxBatchStake"),
  configGasPriceGwei: $("configGasPriceGwei"),
  configAutoSellGasPriceGwei: $("configAutoSellGasPriceGwei"),
  configAutoSellEnabled: $("configAutoSellEnabled"),
  configAutoSellStartDelay: $("configAutoSellStartDelay"),
  configAutoSellInterval: $("configAutoSellInterval"),
  configAutoSellChunk: $("configAutoSellChunk"),
  configAutoSellStopLossEnabled: $("configAutoSellStopLossEnabled"),
  configAutoSellStopLoss: $("configAutoSellStopLoss"),
  configAutoSellStopLossSell: $("configAutoSellStopLossSell"),
  configAdminToken: $("configAdminToken"),
  saveConfigBtn: $("saveConfigBtn"),
  configStatus: $("configStatus"),
  configActiveSellMode: $("configActiveSellMode"),
  priceExitPanel: $("priceExitPanel"),
  priceExitPlanLabel: $("priceExitPlanLabel"),
  priceExitStatus: $("priceExitStatus"),
  priceExitCadence: $("priceExitCadence"),
  priceExitRows: $("priceExitRows"),
  priceExitApplyExisting: $("priceExitApplyExisting"),
  priceExitAdminField: $("priceExitAdminField"),
  priceExitAdminToken: $("priceExitAdminToken"),
  addPriceExitTarget: $("addPriceExitTarget"),
  savePriceExitConfig: $("savePriceExitConfig"),
  priceExitMessage: $("priceExitMessage"),
  orderflowPanel: $("orderflowPanel"),
  orderflowStatus: $("orderflowStatus"),
  orderflowMonitorList: $("orderflowMonitorList"),
  watchedAddressStatus: $("watchedAddressStatus"),
  watchedAddressMonitorList: $("watchedAddressMonitorList"),
  watchedAddressActivityStatus: $("watchedAddressActivityStatus"),
  watchedAddressActivityList: $("watchedAddressActivityList"),
  sellDrawer: $("sellDrawer"),
  sellBackdrop: $("sellBackdrop"),
  closeDialog: $("closeDialog"),
  sellTitle: $("sellTitle"),
  sellOutcome: $("sellOutcome"),
  sellContext: $("sellContext"),
  sellPercentText: $("sellPercentText"),
  sellPercentRange: $("sellPercentRange"),
  sellPercentInput: $("sellPercentInput"),
  quoteBox: $("quoteBox"),
  quoteRefresh: $("quoteRefresh"),
  confirmSell: $("confirmSell"),
  toast: $("toast")
};

renderStaticIcons();
bindNavigation();
bindSellControls();
bindRuntimeConfigControls();
bindPriceExitControls();
setRoute(state.route, { replace: true });

els.refreshBtn.addEventListener("click", async () => {
  await loadOverview({ force: true });
  await loadAutomationStatus();
  await loadPriceExitConfig({ force: true });
  await loadOrderflowMonitors();
  if (state.route === "watchlist") await loadWatchedAddressActivity();
});
window.addEventListener("hashchange", () => setRoute(routeFromHash(), { replace: true }));

loadOverview();
loadAutomationStatus();
loadRuntimeConfig();
loadPriceExitConfig();
loadOrderflowMonitors();
if (state.route === "watchlist") loadWatchedAddressActivity();
state.timer = setInterval(() => {
  updateCountdowns();
  if (document.visibilityState === "visible") loadOverview();
  if (document.visibilityState === "visible" && state.route === "strategy") loadPriceExitConfig();
  if (document.visibilityState === "visible" && state.route === "watchlist") loadWatchedAddressActivity();
}, overviewRefreshMs);
state.automationTimer = setInterval(() => {
  if (document.visibilityState === "visible") loadAutomationStatus();
}, automationRefreshMs);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadOverview();
  if (document.visibilityState === "visible") loadAutomationStatus();
  if (document.visibilityState === "visible" && state.route === "strategy") loadPriceExitConfig();
  if (document.visibilityState === "visible" && state.route === "watchlist") loadWatchedAddressActivity();
});
setInterval(updateCountdowns, 1000);

async function loadOverview({ force = false } = {}) {
  if (force) els.refreshBtn.disabled = true;
  try {
    const data = await api(force ? "/api/overview?refresh=1" : "/api/overview");
    state.data = data;
    render(data);
  } catch (error) {
    showToast(error.message || "刷新失败");
  } finally {
    els.refreshBtn.disabled = false;
  }
}

async function loadAutomationStatus() {
  if (!els.automationRuntimeGrid) return;
  try {
    state.automationStatus = await api("/api/automation-status");
  } catch (error) {
    state.automationStatus = {
      ok: false,
      updatedAt: new Date().toISOString(),
      worker: { label: "状态读取失败", tone: "bad" },
      buy: { label: "状态读取失败", tone: "bad", policyLabel: error.message || "接口不可用" },
      sell: { label: "状态读取失败", tone: "bad", strategyLabel: error.message || "接口不可用" }
    };
  }
  renderAutomationStatus();
}

async function loadRuntimeConfig({ force = false } = {}) {
  try {
    const data = await api("/api/runtime-config");
    state.runtimeConfig = data.config;
    state.runtimeConfigEditable = data.editable ?? state.runtimeConfigEditable ?? {};
    state.runtimeWriteProtected = Boolean(data.writeProtected);
    if (!state.configDirty || force) setRuntimeConfigForm(data.config);
    els.configStatus.textContent = runtimeStatusText(data.config);
    syncAdminTokenField();
  } catch (error) {
    els.configStatus.textContent = error.message || "配置读取失败";
  }
}

async function loadPriceExitConfig({ force = false } = {}) {
  if (!els.priceExitPanel) return;
  if (state.priceExitDirty && !force) return;
  try {
    const data = await api("/api/planned-price-exit");
    state.priceExitPayload = data;
    state.priceExitWriteProtected = Boolean(data.writeProtected);
    state.priceExitDraft = Array.isArray(data.targets)
      ? data.targets.map((target) => ({ outcome: target.outcome, price: String(target.price), enabled: target.enabled !== false }))
      : [];
    state.priceExitDirty = false;
    renderPriceExitConfig();
    syncAdminTokenField();
  } catch (error) {
    state.priceExitPayload = { ok: false, enabled: false, message: error.message || "价格配置读取失败" };
    els.priceExitPanel.classList.add("isHidden");
  }
}

function renderPriceExitConfig() {
  const payload = state.priceExitPayload;
  if (!els.priceExitPanel || !payload?.enabled) {
    els.priceExitPanel?.classList.add("isHidden");
    return;
  }
  els.priceExitPanel.classList.remove("isHidden");
  els.priceExitPlanLabel.textContent = payload.plan?.label ?? payload.plan?.id ?? "OpenRouter Python";
  const reachedCount = (payload.targets ?? []).filter((target) => target.reached).length;
  els.priceExitStatus.textContent = reachedCount > 0 ? `${reachedCount} 项达到阈值` : `${state.priceExitDraft.length} 项监控中`;
  els.priceExitCadence.innerHTML = [
    `数据 ${payload.priceSource ?? "42 REST"}`,
    `买后 ${formatStrategyDuration(Number(payload.priceHotWindowSeconds ?? 600))} / ${formatStrategyDuration(Number(payload.priceHotPollMs ?? 1000) / 1000)}`,
    `之后 ${formatStrategyDuration(Number(payload.normalPollMs ?? 60000) / 1000)}`,
    `触发卖出 ${formatPlainNumber(payload.sellPercent ?? 100)}%`
  ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  els.priceExitApplyExisting.checked = Boolean(payload.applyToExisting);
  els.priceExitMessage.textContent = payload.positionError
    ? `当前价格读取失败：${payload.positionError}`
    : payload.priceApplyAfterIso
      ? `仅处理 ${formatShortIso(payload.priceApplyAfterIso)} 之后买入的仓位`
      : "价格规则包括已有持仓";
  renderPriceExitRows();
}

function renderPriceExitRows() {
  if (!els.priceExitRows) return;
  const payload = state.priceExitPayload ?? {};
  const outcomes = Array.isArray(payload.outcomes) ? payload.outcomes : [];
  if (state.priceExitDraft.length === 0) {
    els.priceExitRows.innerHTML = `<div class="empty">暂无价格阈值</div>`;
    return;
  }
  els.priceExitRows.innerHTML = state.priceExitDraft.map((target, index) => {
    const live = (payload.targets ?? []).find((item) => normalizeText(item.outcome) === normalizeText(target.outcome));
    const currentPrice = Number(live?.currentPrice);
    const targetPrice = Number(target.price);
    const reached = target.enabled !== false && Number.isFinite(currentPrice) && Number.isFinite(targetPrice) && currentPrice >= targetPrice;
    const options = outcomes.map((outcome) => `<option value="${escapeAttr(outcome)}" ${normalizeText(outcome) === normalizeText(target.outcome) ? "selected" : ""}>${escapeHtml(outcome)}</option>`).join("");
    return `
      <div class="priceExitRow" data-price-exit-index="${index}">
        <input type="checkbox" data-price-exit-field="enabled" ${target.enabled !== false ? "checked" : ""} aria-label="启用 ${escapeAttr(target.outcome)}">
        <select data-price-exit-field="outcome" aria-label="Outcome">${options}</select>
        <span class="priceExitCurrent ${reached ? "reached" : ""}">
          <strong>${Number.isFinite(currentPrice) ? formatOutcomePrice(currentPrice) : "--"}</strong>
          <small>${reached ? "已达阈值" : "等待"}</small>
        </span>
        <input type="number" min="0.00000001" max="1" step="0.0001" value="${escapeAttr(target.price)}" data-price-exit-field="price" aria-label="卖出阈值">
        <button class="ghost iconButton priceExitRemove" type="button" data-price-exit-remove="${index}" aria-label="移除 ${escapeAttr(target.outcome)}"><span data-icon="trash-2"></span></button>
      </div>`;
  }).join("");
  renderStaticIcons(els.priceExitRows);
}

function formatOutcomePrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const decimals = number < 0.01 ? 6 : 4;
  return `$${number.toFixed(decimals)}`;
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

async function loadOrderflowMonitors() {
  if (!els.orderflowPanel) return;
  try {
    const data = await api("/api/orderflow-monitors");
    state.orderflowPayload = data;
    state.orderflowWriteProtected = Boolean(data.writeProtected);
    renderOrderflowMonitors();
  } catch (error) {
    state.orderflowPayload = { ok: false, enabled: false, monitors: [] };
    els.orderflowPanel.classList.add("isHidden");
  }
}

async function loadWatchedAddressActivity() {
  if (!els.watchedAddressActivityList || state.watchedAddressLoading) return;
  state.watchedAddressLoading = true;
  if (els.watchedAddressActivityStatus) els.watchedAddressActivityStatus.textContent = "读取中";
  try {
    const data = await api(`/api/watched-address-activity?lookbackMinutes=${encodeURIComponent(state.watchedAddressLookbackMinutes)}`);
    state.watchedAddressPayload = data;
    renderWatchedAddressActivity();
  } catch (error) {
    state.watchedAddressPayload = { ok: false, enabled: false, monitors: [], activity: [], warnings: [error.message || "读取失败"] };
    renderWatchedAddressActivity();
  } finally {
    state.watchedAddressLoading = false;
  }
}

function render(data) {
  const appName = data.settings?.appName || "42space";
  const consoleTitle = formatConsoleTitle(appName);
  if (els.appTitle) els.appTitle.textContent = consoleTitle;
  document.title = consoleTitle;
  els.updated.textContent = `更新 ${formatTime(data.updatedAt)}`;
  els.botState.textContent = data.bot.label;
  els.botState.className = data.bot.tone;
  els.fundingState.textContent = data.wallet?.label ?? "--";
  els.fundingState.className = data.wallet?.tone ?? "warn";
  els.nextClock.dataset.startsAt = data.next.first?.startsAt ?? "";

  renderOverview(data);
  renderMarkets(data);
  renderPositions(data);
  renderExecution(data.activity);
  renderStrategy(data);
  updateCountdowns();
}

function formatConsoleTitle(appName) {
  const name = String(appName || "42space").trim();
  if (/\bConsole$/i.test(name)) return name;
  return `${name} Bot Console`;
}

function gasCardMeta(cards) {
  const parts = [`${cards.gasFeeBnb} BNB`, `${cards.gasTxCount || 0} tx`];
  if (Number(cards.unpricedGasFeeBnb || 0) > 0) {
    parts.push(`${cards.unpricedGasFeeBnb} BNB 未定价`);
  }
  return parts.join(" · ");
}

function renderOverview(data) {
  const failures = data.activity.filter((row) => row.label.includes("失败"));
  const skipped = data.activity.filter((row) => row.label === "已跳过");
  const attention = [];
  if (!data.bot.running) {
    attention.push({ tone: "warn", title: "Bot 未运行", detail: data.bot.message || "需要检查 launch agent 或手动启动。" });
  } else if (data.wallet?.state === "partial") {
    attention.push({ tone: "warn", title: "部分可买", detail: data.wallet?.message || "当前资金不能覆盖全部待买市场。" });
  } else {
    attention.push({ tone: data.wallet?.ready ? "good" : "warn", title: data.bot.label, detail: data.bot.message || "运行状态正常。" });
  }
  if (!data.wallet?.ready) {
    attention.push({ tone: "warn", title: "资金未通过", detail: data.wallet?.message || "BUSDT 或 BNB 不足。" });
  }
  if (failures.length) {
    attention.push({ tone: "bad", title: `${failures.length} 条失败记录`, detail: failures[0].title });
  }
  if (!failures.length && data.wallet?.state === "all" && data.bot.running) {
    attention.push({ tone: "good", title: "无需人工干预", detail: "当前运行、资金和最近执行记录没有阻断项。" });
  }

  els.attentionList.innerHTML = attention.map((item) => `
    <div class="attentionItem ${item.tone}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    </div>
  `).join("");

  const cards = data.analytics.cards;
  els.overviewSnapshot.innerHTML = `
    ${summaryCard("投入", `${cards.invested} U`, "累计买入", true)}
    ${summaryCard("卖出", `${cards.totalSold} U`, "累计收回", true)}
    ${summaryCard("当前", `${cards.openValue} U`, "剩余仓位", true)}
    ${summaryCard("已实现", `${cards.realizedPnl} U`, "已卖出盈亏", cards.realizedPositive)}
    ${summaryCard("未实现", `${cards.unrealizedPnl} U`, "当前浮盈亏", cards.unrealizedPositive)}
    ${summaryCard("毛盈亏", `${cards.grossPnl} U`, "未扣 Gas", cards.totalPositive)}
    ${summaryCard("Gas", `${cards.gasFee} U`, gasCardMeta(cards), false)}
    ${summaryCard("净盈亏", `${cards.totalPnl} U`, `已扣 Gas · ${cards.totalRoi}`, cards.totalPositive)}
  `;

  const next = data.next.first;
  els.overviewNextAction.innerHTML = next ? `
    <div class="nextAction">
      <strong>${escapeHtml(next.title)}</strong>
      <span>${formatDate(next.startsAt)} 开 · ${formatDate(next.endsAt)} 结 · ${escapeHtml(next.duration || "")} · 买 ${next.choices} 档 · ${next.stake} U</span>
      <span class="tag" data-countdown="${escapeAttr(next.startsAt)}">--</span>
    </div>
  ` : `<div class="empty">暂无待开盘市场</div>`;

  const reviewRows = [...failures, ...skipped].slice(0, 4);
  els.overviewActivityMini.innerHTML = reviewRows.length ? reviewRows.map(renderCompactActivity).join("") : `<div class="empty">最近没有失败或跳过项</div>`;
}

function renderMarkets(data) {
  renderUpcomingCategoryOptions(data.newMarkets);
  renderNext(data.next);
  renderNewMarkets(data.newMarkets);
}

function renderNewMarkets(feed) {
  const items = upcomingVisibleItems(feed);
  state.visibleUpcomingMarkets = items;
  pruneUpcomingSelection(items);
  const baseCount = feed.excluded ? `${feed.count} 个 · 排除 ${feed.excluded}` : `${feed.count} 个`;
  els.newMarketCount.textContent = items.length === feed.count ? baseCount : `${items.length} / ${feed.count}`;
  renderUpcomingBulkControls(items);
  if (!items.length) {
    els.newMarketList.innerHTML = `<div class="empty">暂无匹配市场</div>`;
    return;
  }
  els.newMarketList.innerHTML = marketTable(items);
}

function marketTable(items) {
  return `
    <div class="tableHeader marketRow">
      <span>Market</span>
      <span>Time</span>
      <span>Decision</span>
      <span></span>
    </div>
    ${items.map((item) => `
      <div class="marketRow ${state.expandedMarkets.has(item.address) ? "isExpanded" : ""}">
        <div class="marketQuestion">
          <div class="marketQuestionHeader">
            <label class="marketSelect" title="选择该市场">
              <input type="checkbox" data-select-upcoming="${escapeAttr(item.address)}" ${state.selectedUpcomingMarkets.has(marketSelectionKey(item)) ? "checked" : ""} aria-label="选择 ${escapeAttr(item.title)}">
            </label>
            <div class="marketQuestionText">
              <strong>${escapeHtml(item.title)}</strong>
              <small>${item.category ? escapeHtml(item.category) : "Event Market"} · 买 ${item.choices} 档</small>
              <div class="tagLine">${(item.tags || []).map((tag) => `<span class="miniTag">${escapeHtml(tag)}</span>`).join("")}</div>
              ${item.filterReason ? `<small class="filterReason">${escapeHtml(item.filterReason)}</small>` : ""}
            </div>
          </div>
        </div>
        <div class="timeCell">
          <small>新出 ${formatDate(item.createdAt)}</small>
          <strong>${formatDate(item.startsAt)}</strong>
          <span>${formatDate(item.endsAt)}</span>
          <small>${escapeHtml(item.duration || "")}</small>
        </div>
        <div><span class="marketState ${marketStateTone(item.tone)}">${escapeHtml(item.state)}</span></div>
        <div class="rowActions">
          <button class="ghost iconButton compactIconButton" type="button" data-follow-action="${item.follow?.allowed ? "block" : "follow"}" data-market='${escapeAttr(JSON.stringify(followPayload(item)))}'>
            ${icon(item.follow?.allowed ? "bookmark-x" : "bookmark")}
            <span>${item.follow?.allowed ? "取消关注" : "关注"}</span>
          </button>
          <button class="ghost iconButton iconOnly" type="button" data-expand-market="${escapeAttr(item.address)}" aria-label="展开选项">
            ${icon(state.expandedMarkets.has(item.address) ? "chevron-down" : "chevron-right")}
          </button>
        </div>
        ${state.expandedMarkets.has(item.address) ? renderMarketDetail(item.address) : ""}
      </div>
    `).join("")}
  `;
}

function upcomingVisibleItems(feed = state.data?.newMarkets) {
  return (feed?.items ?? []).filter(upcomingMatchesFilters);
}

function renderUpcomingBulkControls(items = state.visibleUpcomingMarkets) {
  const visibleKeys = visibleUpcomingKeys(items);
  const selectedCount = [...state.selectedUpcomingMarkets].filter((key) => visibleKeys.has(key)).length;
  const allSelected = items.length > 0 && selectedCount === items.length;
  if (els.upcomingSelectedCount) {
    els.upcomingSelectedCount.textContent = selectedCount ? `${selectedCount} 已选` : `${items.length} 可选`;
  }
  if (els.selectAllUpcoming) {
    setButtonLabel(els.selectAllUpcoming, allSelected ? "x" : "check-square", allSelected ? "取消全选" : "全选");
    els.selectAllUpcoming.disabled = state.upcomingBulkBusy || items.length === 0;
  }
  if (els.bulkFollowUpcoming) els.bulkFollowUpcoming.disabled = state.upcomingBulkBusy || selectedCount === 0;
  if (els.bulkBlockUpcoming) els.bulkBlockUpcoming.disabled = state.upcomingBulkBusy || selectedCount === 0;
}

function pruneUpcomingSelection(items) {
  const visibleKeys = visibleUpcomingKeys(items);
  for (const key of [...state.selectedUpcomingMarkets]) {
    if (!visibleKeys.has(key)) state.selectedUpcomingMarkets.delete(key);
  }
}

function visibleUpcomingKeys(items) {
  return new Set((items ?? []).map(marketSelectionKey).filter(Boolean));
}

function marketSelectionKey(itemOrAddress) {
  const address = typeof itemOrAddress === "string" ? itemOrAddress : itemOrAddress?.address;
  return String(address ?? "").trim().toLowerCase();
}

function renderNext(next) {
  if (!els.nextCount || !els.upcomingList) return;
  els.nextCount.textContent = `${next.count} 场`;
  if (!next.items.length) {
    els.upcomingList.innerHTML = `<div class="empty">暂无</div>`;
    return;
  }
  els.upcomingList.innerHTML = next.items.map((item) => `
    <div class="compactRow">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${formatDate(item.startsAt)} 开 · ${formatDate(item.endsAt)} 结 · ${escapeHtml(item.duration || "")}</span>
      <span>${escapeHtml(item.state || "")} · 买 ${item.choices} 档 · ${item.stake} U</span>
      <span class="tag" data-countdown="${escapeAttr(item.startsAt)}">--</span>
    </div>
  `).join("");
}

function renderUpcomingCategoryOptions(feed) {
  if (!els.upcomingCategoryFilter) return;
  const categories = [...new Set((feed.items ?? [])
    .filter((item) => item.timeGroup === "future")
    .flatMap((item) => [item.category, ...(item.categories ?? [])])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const current = state.categoryFilter;
  els.upcomingCategoryFilter.innerHTML = [
    `<option value="all">全部类别</option>`,
    ...categories.map((category) => `<option value="${escapeAttr(category)}">${escapeHtml(category)}</option>`)
  ].join("");
  els.upcomingCategoryFilter.value = categories.includes(current) ? current : "all";
  state.categoryFilter = els.upcomingCategoryFilter.value;
}

function upcomingMatchesFilters(item) {
  if (item.timeGroup !== "future") return false;
  const startsAt = new Date(item.startsAt).getTime();
  const horizonMs = Number(state.upcomingHorizonDays) * 86400000;
  if (Number.isFinite(startsAt) && startsAt - Date.now() > horizonMs) return false;

  const hours = Number(item.durationHours);
  if (state.durationFilter === "ge48" && (!Number.isFinite(hours) || hours < 48)) return false;
  if (state.durationFilter === "lt48" && Number.isFinite(hours) && hours >= 48) return false;

  if (state.categoryFilter !== "all") {
    const categories = [item.category, ...(item.categories ?? [])].map((value) => String(value ?? "").toLowerCase());
    if (!categories.includes(state.categoryFilter.toLowerCase())) return false;
  }
  return true;
}

function followPayload(item) {
  return {
    market: item.address,
    title: item.title,
    category: item.category,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    snapshot: {
      address: item.address,
      title: item.title,
      category: item.category,
      startsAt: item.startsAt,
      endsAt: item.endsAt
    }
  };
}

function renderMarketDetail(address) {
  const detail = state.marketDetails.get(address);
  if (!detail) return `<div class="marketDetail"><div class="empty">读取选项中</div></div>`;
  if (detail.error) return `<div class="marketDetail"><div class="empty">${escapeHtml(detail.error)}</div></div>`;
  const outcomes = detail.market?.outcomes ?? [];
  if (!outcomes.length) return `<div class="marketDetail"><div class="empty">暂无选项数据</div></div>`;
  return `
    <div class="marketDetail">
      <div class="outcomeHeader">
        <span>选项</span>
        <span>价格</span>
        <span>赔率</span>
        <span>成交</span>
      </div>
      ${outcomes.map((outcome) => `
        <div class="outcomeRow">
          <strong>${escapeHtml(outcome.name)}</strong>
          <span>${escapeHtml(outcome.price)}</span>
          <span>${escapeHtml(outcome.odds)}</span>
          <span>${escapeHtml(outcome.volume)} U</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderPositions(data) {
  const cards = data.analytics.cards;
  els.positionSummary.innerHTML = `
    ${summaryCard("投入", `${cards.invested} U`, "累计买入", true)}
    ${summaryCard("卖出", `${cards.totalSold} U`, "累计收回", true)}
    ${summaryCard("当前", `${cards.openValue} U`, `${data.holdings.count} 个可卖`, true)}
    ${summaryCard("已实现", `${cards.realizedPnl} U`, "已卖出盈亏", cards.realizedPositive)}
    ${summaryCard("未实现", `${cards.unrealizedPnl} U`, "当前浮盈亏", cards.unrealizedPositive)}
    ${summaryCard("毛盈亏", `${cards.grossPnl} U`, "未扣 Gas", cards.totalPositive)}
    ${summaryCard("Gas", `${cards.gasFee} U`, gasCardMeta(cards), false)}
    ${summaryCard("净盈亏", `${cards.totalPnl} U`, `已扣 Gas · ${cards.totalRoi}`, cards.totalPositive)}
  `;
  renderAggregatePnl(data.analytics.aggregatePnl);
  renderProjectBoard(data.projectBoard);
}

function renderAggregatePnl(aggregate) {
  if (!els.aggregatePnlPanel) return;
  if (!aggregate?.enabled || !aggregate.series?.length) {
    els.aggregatePnlPanel.classList.add("isHidden");
    els.aggregatePnlPanel.innerHTML = "";
    return;
  }
  const cards = aggregate.cards ?? {};
  const warnings = aggregate.warnings ?? [];
  els.aggregatePnlPanel.classList.remove("isHidden");
  els.aggregatePnlPanel.innerHTML = `
    <div class="panelHead">
      <div>
        <h3><i data-icon="bar-chart-3"></i>${escapeHtml(aggregate.title || "Bot1-Bot5 总净盈亏")}</h3>
        <p>线为累计净盈亏，柱为每天净增加</p>
      </div>
      <span>${escapeHtml(aggregate.timeZone || "")}</span>
    </div>
    <div class="aggregatePnlBody">
      <div class="aggregateSummary">
        ${summaryCard("总净盈亏", `${cards.totalNet ?? "0"} U`, `含当前浮盈亏 · ${cards.roi ?? "--"}`, cards.totalPositive)}
        ${summaryCard("累计记账", `${cards.realizedNet ?? "0"} U`, "已实现减 Gas", cards.realizedPositive)}
        ${summaryCard("今日净增加", `${cards.dailyNet ?? "0"} U`, "按交易日", cards.dailyPositive)}
        ${summaryCard("当前浮盈亏", `${cards.openPnl ?? "0"} U`, "未实现", cards.openPositive)}
      </div>
      <div class="aggregateChartWrap">
        ${aggregatePnlChart(aggregate.series)}
      </div>
      <div class="aggregateProfiles">
        ${(aggregate.profiles ?? []).map((profile) => `
          <div class="aggregateProfile ${profile.ok ? "" : "hasWarning"}">
            <span>${escapeHtml(profile.label)}</span>
            <strong class="${profile.positive ? "good" : "bad"}">${escapeHtml(profile.netPnl)} U</strong>
            <small>${escapeHtml(profile.wallet || "")} · 记账 ${escapeHtml(profile.realizedNet)} U · 浮盈亏 ${escapeHtml(profile.openPnl)} U</small>
            ${profile.warning ? `<em>${escapeHtml(profile.warning)}</em>` : ""}
          </div>
        `).join("")}
      </div>
      ${warnings.length ? `<div class="aggregateWarnings">${warnings.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>` : ""}
    </div>
  `;
  renderStaticIcons();
}

function aggregatePnlChart(series = []) {
  const rows = series.filter((row) => Number.isFinite(Number(row.cumulativeNet)) && Number.isFinite(Number(row.dailyNet)));
  if (!rows.length) return `<div class="empty">暂无盈亏数据</div>`;
  const width = 760;
  const height = 280;
  const pad = { top: 20, right: 18, bottom: 34, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = rows.flatMap((row) => [Number(row.cumulativeNet), Number(row.dailyNet), 0]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const yMin = min - span * 0.08;
  const yMax = max + span * 0.08;
  const xStep = rows.length > 1 ? innerW / (rows.length - 1) : innerW;
  const barSlot = innerW / Math.max(1, rows.length);
  const barW = Math.max(3, Math.min(18, barSlot * 0.58));
  const y = (value) => pad.top + (yMax - value) / Math.max(1, yMax - yMin) * innerH;
  const x = (index) => pad.left + (rows.length > 1 ? index * xStep : innerW / 2);
  const zeroY = y(0);
  const linePoints = rows.map((row, index) => `${x(index).toFixed(2)},${y(Number(row.cumulativeNet)).toFixed(2)}`).join(" ");
  const bars = rows.map((row, index) => {
    const value = Number(row.dailyNet);
    const barX = x(index) - barW / 2;
    const barY = Math.min(y(value), zeroY);
    const barH = Math.max(1, Math.abs(zeroY - y(value)));
    const tone = value >= 0 ? "positive" : "negative";
    return `<rect class="pnlBar ${tone}" x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barW.toFixed(2)}" height="${barH.toFixed(2)}"><title>${escapeHtml(row.label)} 每日 ${escapeHtml(row.dailyNetText)} U</title></rect>`;
  }).join("");
  const barLabels = rows.map((row, index) => {
    const value = Number(row.dailyNet);
    const rounded = Math.round(value);
    if (rounded === 0) return "";
    const labelX = x(index);
    const labelY = value >= 0 ? y(value) - 5 : y(value) + 14;
    return `<text class="barValueLabel ${value >= 0 ? "positive" : "negative"}" x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}">${escapeHtml(formatInteger(value, { positiveSign: false }))}</text>`;
  }).join("");
  const last = rows.at(-1);
  const lastX = x(rows.length - 1);
  const lastY = y(Number(last.cumulativeNet));
  return `
    <svg class="aggregateChart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bot1-Bot5 累计净盈亏曲线和每日净增加柱状图">
      <line class="axisLine" x1="${pad.left}" x2="${width - pad.right}" y1="${zeroY.toFixed(2)}" y2="${zeroY.toFixed(2)}"></line>
      <line class="gridLine" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top}" y2="${pad.top}"></line>
      <line class="gridLine" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
      ${bars}
      <polyline class="pnlLine" points="${linePoints}"></polyline>
      <circle class="pnlPoint" cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="4"></circle>
      ${barLabels}
      <text class="axisLabel" x="8" y="${pad.top + 4}">${escapeHtml(formatMoneyShort(yMax))} U</text>
      <text class="axisLabel" x="8" y="${height - pad.bottom + 4}">${escapeHtml(formatMoneyShort(yMin))} U</text>
      <text class="axisLabel" x="${pad.left}" y="${height - 8}">${escapeHtml(rows[0].label)}</text>
      <text class="axisLabel end" x="${width - pad.right}" y="${height - 8}">${escapeHtml(last.label)}</text>
    </svg>
    <div class="aggregateLegend">
      <span><i class="legendLine"></i>累计 ${escapeHtml(last.cumulativeNetText)} U</span>
      <span><i class="legendBar"></i>每日净增加 · 同一比例</span>
    </div>
  `;
}

function renderProjectBoard(board) {
  if (!els.projectBoardList) return;
  els.projectBoardCount.textContent = `${board?.count ?? 0} 个`;
  const active = board?.active ?? [];
  if (!active.length) {
    els.projectBoardList.innerHTML = `<div class="empty">暂无关注项目</div>`;
  } else {
    els.projectBoardList.innerHTML = active.map(renderProjectBoardRow).join("");
  }
  bindSellButtons(els.projectBoardList);

  const history = board?.history ?? [];
  const label = state.showHistoryProjects ? "隐藏历史项目" : "展示历史项目";
  if (els.toggleHistoryProjects) {
    setButtonLabel(els.toggleHistoryProjects, state.showHistoryProjects ? "chevron-down" : "chevron-right", `${label}${history.length ? ` · ${history.length}` : ""}`);
  }
  if (els.historyProjectList) {
    els.historyProjectList.classList.toggle("isHidden", !state.showHistoryProjects);
    els.historyProjectList.innerHTML = history.length
      ? history.map(renderHistoryProjectRow).join("")
      : `<div class="empty">暂无历史项目</div>`;
  }
}

function renderProjectBoardRow(project) {
  const expanded = state.projectExpanded.has(project.market);
  const holding = project.holding;
  return `
    <section class="projectBoardRow ${expanded ? "isExpanded" : ""}">
      <div class="projectBoardTop">
        <div class="projectBoardTitle">
          <strong title="${escapeAttr(project.title)}">${escapeHtml(project.title)}</strong>
          <span>${projectMetaText(project)}</span>
        </div>
        <div class="projectBoardStats">
          ${holding ? renderProjectTotalStats(holding) : renderPlannedProjectStats(project)}
        </div>
        <button class="ghost iconButton iconOnly" type="button" data-expand-project="${escapeAttr(project.market)}" aria-label="展开项目">
          ${icon(expanded ? "chevron-down" : "chevron-right")}
        </button>
      </div>
      ${expanded ? renderProjectBoardDetail(project) : ""}
    </section>
  `;
}

function renderProjectBoardDetail(project) {
  const holding = project.holding;
  if (!holding) {
    return `
      <div class="projectBoardDetail">
        <div class="empty">还没有持仓，自动买入后这里会更新。</div>
      </div>
    `;
  }
  const sellBlocked = Boolean(state.data?.manualSell?.blocked);
  const sellBlockMessage = state.data?.manualSell?.message ?? "";
  return `
    <div class="projectBoardDetail">
      <div class="projectBoardDetailActions">
        <button
          class="sellAllBtn iconButton"
          data-sell='${escapeAttr(JSON.stringify(projectSellItem(project)))}'
          title="${escapeAttr(sellBlocked ? sellBlockMessage : "卖出该事件全部持仓")}"
          ${holding.sellable && !sellBlocked ? "" : "disabled"}
        >${icon("badge-dollar-sign")}<span>一键卖出全部</span></button>
      </div>
      ${holding.items.map((item) => renderPosition(item, { sellBlocked, sellBlockMessage })).join("")}
    </div>
  `;
}

function renderHistoryProjectRow(project) {
  const expanded = state.historyExpanded.has(project.market);
  return `
    <section class="projectBoardRow historyProjectRow ${expanded ? "isExpanded" : ""}">
      <div class="projectBoardTop">
        <div class="projectBoardTitle">
          <strong title="${escapeAttr(project.title)}">${escapeHtml(project.title)}</strong>
          <span>${projectMetaText(project, { history: true })}</span>
        </div>
        <div class="projectBoardStats">
          ${renderProjectTotalStats(project)}
        </div>
        <button class="ghost iconButton iconOnly" type="button" data-expand-history-project="${escapeAttr(project.market)}" aria-label="展开历史项目">
          ${icon(expanded ? "chevron-down" : "chevron-right")}
        </button>
      </div>
      ${expanded ? renderHistoryProjectDetail(project) : ""}
    </section>
  `;
}

function renderHistoryProjectDetail(project) {
  const items = project.items ?? [];
  return `
    <div class="projectBoardDetail">
      ${items.length ? items.map(renderHistoryPosition).join("") : `<div class="empty">暂无选项明细</div>`}
    </div>
  `;
}

function renderHistoryPosition(item) {
  return `
    <div class="positionRow historyPositionRow">
      <div class="positionName">
        ${escapeHtml(item.outcome)}
        ${item.tokenId ? `<small>Token ${escapeHtml(String(item.tokenId))}</small>` : ""}
      </div>
      <div class="positionStats">
        <div class="stat"><span>买入价</span><strong>${item.buyPrice}</strong></div>
        <div class="stat"><span>投入</span><strong>${item.bought} U</strong></div>
        <div class="stat"><span>已卖出</span><strong>${item.sold} U</strong></div>
        <div class="stat"><span>已实现</span><strong class="${signedTone(item.realized)}">${item.realized} U</strong></div>
        <div class="stat"><span>Gas</span><strong>${item.gas ?? "0"} U</strong></div>
        <div class="stat"><span>毛盈亏</span><strong class="${signedTone(item.grossPnl ?? item.realized)}">${item.grossPnl ?? item.realized} U</strong></div>
        <div class="stat"><span>净盈亏</span><strong class="${item.positive ? "good" : "bad"}">${item.pnl} U</strong></div>
        <div class="stat"><span>收益</span><strong class="${item.positive ? "good" : "bad"}">${item.roi}</strong></div>
        <div class="stat"><span>最后</span><strong>${item.lastAt ? formatDate(item.lastAt) : "--"}</strong></div>
      </div>
    </div>
  `;
}

function projectMetaText(project, { history = false } = {}) {
  const parts = [];
  if (project.category) parts.push(escapeHtml(project.category));
  parts.push(escapeHtml(history ? "历史项目" : (project.follow?.label ?? project.state ?? "项目")));
  if (project.startsAt) parts.push(`开盘 ${formatDate(project.startsAt)}`);
  if (project.matchStartsAt) parts.push(`比赛 ${formatDate(project.matchStartsAt)}`);
  if (history && project.lastAt) parts.push(`最后 ${formatDate(project.lastAt)}`);
  if (!project.startsAt && !project.matchStartsAt && !history) parts.push("等待自动更新");
  return parts.join(" · ");
}

function renderProjectTotalStats(project) {
  const current = project.value ?? project.openValue;
  return `
    <span>投入 ${escapeHtml(project.cost ?? project.bought ?? "--")} U</span>
    ${project.sold !== undefined ? `<span>已卖出 ${escapeHtml(project.sold)} U</span>` : ""}
    ${current !== undefined ? `<span>当前 ${escapeHtml(current)} U</span>` : ""}
    ${project.grossPnl !== undefined ? `<span>毛盈亏 ${escapeHtml(project.grossPnl)} U</span>` : ""}
    ${project.gas !== undefined ? `<span>Gas ${escapeHtml(project.gas)} U</span>` : ""}
    <strong class="${project.positive ? "good" : "bad"}">净盈亏 ${escapeHtml(project.pnl ?? "--")} U</strong>
    ${project.roi ? `<span>收益 ${escapeHtml(project.roi)}</span>` : ""}
  `;
}

function renderPlannedProjectStats(project) {
  const pieces = [];
  if (project.choices) pieces.push(`<span>买 ${escapeHtml(String(project.choices))} 档</span>`);
  if (project.stake) pieces.push(`<span>计划 ${escapeHtml(project.stake)} U</span>`);
  return pieces.join("") || `<span>${escapeHtml(project.state || "")}</span>`;
}

function projectSellItem(project) {
  const holding = project.holding ?? {};
  return {
    all: true,
    market: project.market,
    title: project.title,
    outcome: "全部选项",
    chips: `${holding.sellableCount ?? 0} 个选项`,
    cost: holding.cost,
    sold: holding.sold,
    value: holding.value,
    realized: holding.realized,
    unrealized: holding.unrealized,
    grossPnl: holding.grossPnl,
    gas: holding.gas,
    gasBnb: holding.gasBnb,
    pnl: holding.pnl,
    pnlPct: holding.roi ?? "",
    positive: holding.positive,
    sellable: holding.sellable
  };
}

function bindSellButtons(root = document) {
  for (const button of root.querySelectorAll("[data-sell]")) {
    if (button.dataset.sellBound === "1") continue;
    button.dataset.sellBound = "1";
    button.addEventListener("click", () => openSell(JSON.parse(button.dataset.sell)));
  }
}

function renderPosition(item, { sellBlocked = false, sellBlockMessage = "" } = {}) {
  return `
    <div class="positionRow">
      <div class="positionName">${escapeHtml(item.outcome)}</div>
      <div class="positionStats">
        <div class="stat"><span>买入价</span><strong>${item.buyPrice}</strong></div>
        <div class="stat"><span>当前价</span><strong>${item.nowPrice}</strong></div>
        <div class="stat"><span>筹码</span><strong>${item.chips}</strong></div>
        <div class="stat"><span>投入</span><strong>${item.cost} U</strong></div>
        <div class="stat"><span>已卖出</span><strong>${item.sold} U</strong></div>
        <div class="stat"><span>当前</span><strong>${item.value} U</strong></div>
        <div class="stat"><span>已实现</span><strong class="${signedTone(item.realized)}">${item.realized} U</strong></div>
        <div class="stat"><span>未实现</span><strong class="${signedTone(item.unrealized)}">${item.unrealized} U</strong></div>
        <div class="stat"><span>Gas</span><strong>${item.gas ?? "0"} U</strong></div>
        <div class="stat"><span>毛盈亏</span><strong class="${signedTone(item.grossPnl ?? item.pnl)}">${item.grossPnl ?? item.pnl} U</strong></div>
        <div class="stat"><span>净盈亏</span><strong class="${item.positive ? "good" : "bad"}">${item.pnl} U</strong></div>
        <div class="stat"><span>收益</span><strong class="${item.positive ? "good" : "bad"}">${item.pnlPct}</strong></div>
      </div>
      <button
        class="sellBtn iconButton"
        data-sell='${escapeAttr(JSON.stringify(item))}'
        title="${escapeAttr(sellBlocked ? sellBlockMessage : "卖出该选项")}"
        ${item.sellable && !sellBlocked ? "" : "disabled"}
      >${icon("badge-dollar-sign")}<span>卖出</span></button>
    </div>
  `;
}

function renderExecution(rows) {
  if (!rows.length) {
    els.activityList.innerHTML = `<div class="empty">暂无</div>`;
    return;
  }
  els.activityList.innerHTML = rows.map(renderActivityRow).join("");
}

function renderActivityRow(row) {
  const title = splitActivityTitle(row.title);
  return `
    <div class="activityRow">
      <div class="activityBody">
        <div class="activityTitle" title="${escapeAttr(row.title)}">${escapeHtml(title.main)}</div>
        ${title.detail ? `<div class="activityOutcome">${escapeHtml(title.detail)}</div>` : ""}
        <div class="activityMeta">
          <span>${icon("clock", "metaIcon")}${formatTime(row.time)}</span>
          ${row.amount ? `<span>${escapeHtml(row.amount)}</span>` : ""}
        </div>
      </div>
      <span class="activityType ${activityTone(row.label)}">${escapeHtml(row.label)}</span>
    </div>
  `;
}

function renderCompactActivity(row) {
  return `
    <div class="compactRow">
      <strong title="${escapeAttr(row.title)}">${escapeHtml(splitActivityTitle(row.title).main)}</strong>
      <span>${formatTime(row.time)} · ${escapeHtml(row.label)}</span>
    </div>
  `;
}

function renderStrategy(data) {
  renderStrategyProfile(data.settings?.strategyProfile);
  renderAutomationStatus();
  const rules = data.settings?.ruleSummary ?? {};
  if (els.ruleFilterText) els.ruleFilterText.textContent = rules.filterRule ?? "--";
  if (els.ruleDisplayText) els.ruleDisplayText.textContent = rules.displayRule ?? "--";
  if (els.ruleFollowText) els.ruleFollowText.textContent = rules.followRule ?? "--";
  if (els.ruleNotifyText) els.ruleNotifyText.textContent = rules.notificationRule ?? "--";
  if (!state.configDirty && data.settings?.runtimeConfig) setRuntimeConfigForm(data.settings.runtimeConfig);
  const checks = [
    { label: "运行状态", value: data.bot.label, tone: data.bot.tone },
    { label: "资金状态", value: data.wallet ? `${data.wallet.label} · ${data.wallet.busdt} U / ${data.wallet.bnb} BNB` : "--", tone: data.wallet?.tone ?? "warn" },
    { label: "手动卖出", value: data.manualSell?.label ?? "--", tone: data.manualSell?.blocked ? "warn" : "good" },
    { label: "下一批市场", value: `${data.next.count} 场`, tone: data.next.count ? "warn" : "neutral" },
    { label: "持仓数量", value: `${data.holdings.count} 个`, tone: data.holdings.count ? "good" : "neutral" },
    ...evidencePreflightRows(data.evidence)
  ];
  els.preflightList.innerHTML = checks.map((check) => `
    <div class="preflightRow">
      <span>${escapeHtml(check.label)}</span>
      <strong class="${check.tone}">${escapeHtml(check.value)}</strong>
    </div>
  `).join("");
  renderOrderflowMonitors();
}

function renderAutomationStatus() {
  if (!els.automationRuntimeGrid) return;
  const status = state.automationStatus;
  if (!status) {
    els.automationRuntimeGrid.innerHTML = automationStatusPlaceholder();
    els.automationRuntimeUpdated.textContent = "读取中";
    return;
  }
  els.automationRuntimeUpdated.textContent = `状态 ${formatHealthAge(Date.now() - Date.parse(status.updatedAt ?? ""))}`;
  const worker = status.worker ?? {};
  const buy = status.buy ?? {};
  const sell = status.sell ?? {};
  const workerMeta = [
    worker.pid ? `PID ${worker.pid}` : null,
    Number.isFinite(Number(worker.restartCount)) ? `重启 ${worker.restartCount} 次` : null,
    status.heartbeat?.ageMs !== null && status.heartbeat?.ageMs !== undefined
      ? `心跳 ${formatHealthAge(status.heartbeat.ageMs)}`
      : "尚无心跳"
  ].filter(Boolean);
  const buyMeta = [
    `待处理 ${Number(buy.pendingCount ?? 0)} 场`,
    `已准备 ${Number(buy.preparedCount ?? 0)} 场`,
    buy.lastAction?.at ? `最近交易 ${formatShortIso(buy.lastAction.at)}` : "暂无买入记录"
  ];
  const sellMeta = [
    sell.lastSuccessfulScanAt ? `有效扫描 ${formatHealthAge(Date.now() - Date.parse(sell.lastSuccessfulScanAt))}` : "尚无有效扫描",
    `检查 ${Number(sell.checked ?? 0)} 个持仓`,
    sell.pollMs ? `轮询 ${formatStrategyDuration(Number(sell.pollMs) / 1000)}` : null,
    sell.guardUntil ? `保护至 ${formatShortIso(sell.guardUntil)}` : null,
    sell.lastAction?.at ? `最近卖出 ${formatShortIso(sell.lastAction.at)}` : null
  ].filter(Boolean);
  els.automationRuntimeGrid.innerHTML = [
    automationStatusLane({
      iconName: "radio",
      label: "主 Worker",
      status: worker.label ?? "--",
      tone: worker.tone ?? "neutral",
      detail: worker.running ? "事件发现、预签名和交易调度主进程" : "主进程未运行",
      meta: workerMeta
    }),
    automationStatusLane({
      iconName: "sparkles",
      label: "自动买入",
      status: buy.label ?? "--",
      tone: buy.tone ?? "neutral",
      detail: buy.policyLabel ?? "--",
      meta: buyMeta
    }),
    automationStatusLane({
      iconName: "timer",
      label: "自动卖出",
      status: sell.label ?? "--",
      tone: sell.tone ?? "neutral",
      detail: sell.lastError && sell.tone === "bad" ? sell.lastError : (sell.strategyLabel ?? "--"),
      meta: sellMeta
    })
  ].join("");
}

function automationStatusLane({ iconName, label, status, tone, detail, meta = [] }) {
  return `
    <article class="automationLane ${escapeAttr(tone)}">
      <div class="automationLaneTop">
        <span>${icon(iconName)}${escapeHtml(label)}</span>
        <strong>${escapeHtml(status)}</strong>
      </div>
      <p>${escapeHtml(detail)}</p>
      <div class="automationLaneMeta">
        ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    </article>
  `;
}

function automationStatusPlaceholder() {
  return ["主 Worker", "自动买入", "自动卖出"].map((label) => `
    <article class="automationLane neutral">
      <div class="automationLaneTop"><span>${escapeHtml(label)}</span><strong>读取中</strong></div>
      <p>--</p>
    </article>
  `).join("");
}

function formatHealthAge(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1500) return "刚刚";
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  return `${Math.floor(ms / 3600000)} 小时前`;
}

function renderStrategyProfile(profile) {
  if (!profile) return;
  els.strategyProfileEyebrow.textContent = profile.eyebrow ?? "PROFILE";
  els.strategyProfileTitle.textContent = profile.title ?? "当前策略";
  els.strategyProfileSummary.textContent = profile.summary ?? "--";
  els.strategyOverrideText.textContent = profile.overrideNote ?? "--";
  els.strategyProfileBadges.innerHTML = (profile.badges ?? []).map((badge) => `
    <span class="strategyBadge ${escapeAttr(badge.tone ?? "neutral")}">${escapeHtml(badge.label ?? "--")}</span>
  `).join("");
  els.strategyFlow.innerHTML = (profile.stages ?? []).map((stage) => `
    <article class="strategyStage">
      <div class="strategyStageTop">
        <span class="strategyStep">${escapeHtml(stage.step ?? "--")}</span>
        ${icon(stage.icon ?? "radio", "strategyStageIcon")}
      </div>
      <span class="strategyStageLabel">${escapeHtml(stage.label ?? "--")}</span>
      <strong>${escapeHtml(stage.title ?? "--")}</strong>
      <p>${escapeHtml(stage.detail ?? "")}</p>
      <div class="strategyStageMeta">
        ${(stage.meta ?? []).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      </div>
    </article>
  `).join("");
  els.strategyFacts.innerHTML = (profile.facts ?? []).map((fact) => `
    <div class="strategyFactRow ${escapeAttr(fact.tone ?? "neutral")}">
      <span>${escapeHtml(fact.label ?? "--")}</span>
      <div>
        <strong>${escapeHtml(fact.value ?? "--")}</strong>
        <p>${escapeHtml(fact.detail ?? "")}</p>
      </div>
    </div>
  `).join("");
  syncSellModeFields(profile.sellMode, profile.sellModeLabel, profile.sellSummary);
}

function renderOrderflowMonitors() {
  if (!els.orderflowPanel || !els.orderflowMonitorList) return;
  const payload = state.orderflowPayload;
  const enabled = Boolean(payload?.enabled);
  els.orderflowPanel.classList.toggle("isHidden", !enabled);
  if (!enabled) return;
  const monitors = Array.isArray(payload.monitors) ? payload.monitors : [];
  const runningCount = monitors.filter((monitor) => monitor.running).length;
  const tokenText = payload.writeProtected ? "需令牌" : "可写";
  els.orderflowStatus.textContent = `${runningCount}/${monitors.length} 运行 · ${tokenText}`;
  els.orderflowMonitorList.innerHTML = monitors.length
    ? monitors.map(renderOrderflowMonitorCard).join("")
    : `<div class="empty">没有可配置的 orderflow 监控。</div>`;
  bindOrderflowControls();
}

function renderOrderflowMonitorCard(monitor) {
  const stateClass = monitor.running ? "good" : monitor.activeState === "failed" ? "bad" : "warn";
  const stateText = monitor.running
    ? "运行中"
    : [monitor.activeState, monitor.subState].filter(Boolean).join(" / ") || "未运行";
  const tokenIds = (monitor.tokenIds ?? []).join(",");
  const startedText = monitor.latestStartedAt
    ? `${formatShortIso(monitor.latestStartedAt)} · ${monitor.latestStartedThresholdUsdt ?? "--"}U`
    : "--";
  const watchedText = monitor.watchCurrentPositions
    ? `当前持仓 + ${monitor.latestStartedWatchedTokenIds?.length ?? monitor.tokenIds?.length ?? 0} 个已启动 Token`
    : `${monitor.tokenIds?.length ?? 0} 个 Token`;
  return `
    <form class="orderflowCard" data-orderflow-id="${escapeAttr(monitor.id)}">
      <div class="orderflowCardHead">
        <div>
          <strong>${escapeHtml(monitor.label)}</strong>
          <span>${escapeHtml(monitor.service)}</span>
        </div>
        <span class="orderflowState ${stateClass}">${escapeHtml(stateText)}</span>
      </div>
      <div class="orderflowFields">
        <label class="field orderflowMarketField">
          <span>事件地址</span>
          <input name="market" value="${escapeAttr(monitor.market)}" spellcheck="false" autocomplete="off">
        </label>
        <label class="field">
          <span>触发阈值 U</span>
          <input name="thresholdUsdt" type="number" min="0.1" max="1000000" step="0.1" value="${escapeAttr(monitor.thresholdUsdt || "")}">
        </label>
        <label class="field tokenField">
          <span>Token IDs</span>
          <input name="tokenIds" value="${escapeAttr(tokenIds)}" spellcheck="false" autocomplete="off" placeholder="用逗号或空格分隔">
        </label>
        <label class="orderflowCheckbox tokenField">
          <input name="watchCurrentPositions" type="checkbox" ${monitor.watchCurrentPositions ? "checked" : ""}>
          <span>按当前持仓自动监控；Token IDs 作为固定补充</span>
        </label>
      </div>
      <div class="orderflowMeta">
        <span>监控：${escapeHtml(watchedText)}</span>
        <span>卖出：${escapeHtml(monitor.sellMode || "--")} · ${escapeHtml(String(monitor.sellPercent || "--"))}%</span>
        <span>轮询：${escapeHtml(String(monitor.pollMs || "--"))}ms</span>
        <span>区块：${escapeHtml(String(monitor.lastProcessedBlock ?? "--"))}</span>
        <span>失败/处理中：${escapeHtml(String(monitor.failedTxCount ?? 0))}/${escapeHtml(String(monitor.processingTxCount ?? 0))}</span>
        <span>最近启动：${escapeHtml(startedText)}</span>
      </div>
      <div class="orderflowActions">
        <small title="${escapeAttr(monitor.unitPath || "")}">${escapeHtml(monitor.profile || "")}</small>
        <button class="iconButton compactIconButton" type="submit">
          ${icon("send")}<span>保存并重启</span>
        </button>
      </div>
    </form>
  `;
}

function renderWatchedAddressActivity() {
  if (!els.watchedAddressMonitorList || !els.watchedAddressActivityList) return;
  const payload = state.watchedAddressPayload;
  if (!payload?.enabled) {
    els.watchedAddressStatus.textContent = "未启用";
    els.watchedAddressActivityStatus.textContent = payload?.warnings?.[0] ?? "未启用";
    els.watchedAddressMonitorList.innerHTML = `<div class="empty">地址监控面板未启用。</div>`;
    els.watchedAddressActivityList.innerHTML = `<div class="empty">暂无地址活动。</div>`;
    return;
  }
  const monitors = Array.isArray(payload.monitors) ? payload.monitors : [];
  const activity = Array.isArray(payload.activity) ? payload.activity : [];
  const runningCount = monitors.filter((monitor) => monitor.running).length;
  els.watchedAddressStatus.textContent = `${runningCount}/${monitors.length} 运行`;
  els.watchedAddressActivityStatus.textContent = `${activity.length} 条 · ${payload.lookbackMinutes ?? state.watchedAddressLookbackMinutes} 分钟`;
  els.watchedAddressMonitorList.innerHTML = monitors.length
    ? monitors.map(renderWatchedAddressMonitorCard).join("")
    : `<div class="empty">没有配置关注地址。</div>`;
  const warnings = payload.warnings?.length
    ? `<div class="watchWarning">${payload.warnings.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
    : "";
  els.watchedAddressActivityList.innerHTML = activity.length
    ? `${warnings}${activity.map(renderWatchedAddressActivityRow).join("")}`
    : `${warnings}<div class="empty">当前回看窗口没有活动。</div>`;
}

function renderWatchedAddressMonitorCard(monitor) {
  const stateClass = monitor.running ? "good" : monitor.activeState === "failed" ? "bad" : "warn";
  const stateText = monitor.running
    ? "运行中"
    : [monitor.activeState, monitor.subState].filter(Boolean).join(" / ") || "未运行";
  const cooldown = monitor.cooldownMs ? `${Math.round(Number(monitor.cooldownMs) / 60000)} 分钟冷却` : "冷却未配置";
  return `
    <section class="watchAddressCard">
      <div class="watchAddressCardHead">
        <div>
          <strong>${escapeHtml(monitor.label || monitor.address)}</strong>
          <span title="${escapeAttr(monitor.address)}">${escapeHtml(monitor.address)}</span>
        </div>
        <span class="orderflowState ${stateClass}">${escapeHtml(stateText)}</span>
      </div>
      <div class="watchAddressMeta">
        <span>区块 ${escapeHtml(String(monitor.lastProcessedBlock ?? "--"))}</span>
        <span>${escapeHtml(cooldown)}</span>
        <span>命中 ${escapeHtml(String(monitor.recentHitCount ?? 0))}</span>
        <span>通知 ${escapeHtml(String(monitor.recentAlertCount ?? 0))}</span>
        <span>已见 ${escapeHtml(String(monitor.seenTxCount ?? 0))}</span>
      </div>
      <div class="watchAddressFoot">
        <small title="${escapeAttr(monitor.service)}">${escapeHtml(monitor.service)}</small>
        <small>${monitor.lastHitAt ? `最近 ${formatShortIso(monitor.lastHitAt)}` : "暂无命中"}</small>
      </div>
      ${monitor.lastError ? `<div class="watchAddressError">${escapeHtml(monitor.lastError)}</div>` : ""}
    </section>
  `;
}

function renderWatchedAddressActivityRow(row) {
  const event = row.event;
  const title = event?.question || "未识别 42 事件";
  const outcome = event?.outcome || "";
  const action = event?.actionLabel || (row.direct ? "原生交易" : row.directionsText || "活动");
  const marketMeta = event?.market
    ? `${shortAddressText(event.market)}${event.tokenId ? ` · Token ${event.tokenId}` : ""}`
    : row.contracts?.length ? `${row.contracts.length} contract` : "";
  return `
    <div class="watchActivityRow">
      <div class="watchActivityMain">
        <div class="watchActivityTop">
          <span class="activityType ${watchActionTone(action)}">${escapeHtml(action)}</span>
          <strong title="${escapeAttr(title)}">${escapeHtml(title)}</strong>
        </div>
        ${outcome ? `<div class="activityOutcome">${escapeHtml(outcome)}</div>` : ""}
        <div class="activityMeta">
          <span>${icon("clock", "metaIcon")}${formatTime(row.at)}</span>
          <span>${escapeHtml(row.addressLabel || shortAddressText(row.address))}</span>
          ${row.amountText ? `<span>${escapeHtml(row.amountText)}</span>` : ""}
          ${marketMeta ? `<span>${escapeHtml(marketMeta)}</span>` : ""}
        </div>
      </div>
      <div class="watchActivityTx">
        <a href="${escapeAttr(row.explorerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(row.shortTx || shortHashText(row.txHash))}</a>
        <span>${escapeHtml(row.directionsText || "")} · #${escapeHtml(String(row.blockNumber ?? "--"))}</span>
      </div>
    </div>
  `;
}

function watchActionTone(action) {
  if (String(action).includes("买")) return "buy";
  if (String(action).includes("卖") || String(action).includes("赎回") || String(action).includes("转出")) return "sell";
  return "neutral";
}

function bindOrderflowControls() {
  for (const form of els.orderflowMonitorList?.querySelectorAll("[data-orderflow-id]") ?? []) {
    form.addEventListener("submit", saveOrderflowMonitor);
  }
}

async function saveOrderflowMonitor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.dataset.orderflowId;
  const token = els.configAdminToken?.value.trim() ?? "";
  if (state.orderflowWriteProtected && !token) {
    showToast("需要管理令牌");
    return;
  }
  const button = form.querySelector("button[type='submit']");
  const payload = {
    id,
    market: form.elements.market.value.trim(),
    thresholdUsdt: Number(form.elements.thresholdUsdt.value),
    tokenIds: form.elements.tokenIds.value.trim(),
    watchCurrentPositions: form.elements.watchCurrentPositions.checked
  };
  button.disabled = true;
  setButtonLabel(button, "loader-circle", "保存中");
  try {
    const data = await api("/api/orderflow-monitors", {
      method: "PUT",
      headers: token ? { "x-admin-token": token } : {},
      body: JSON.stringify(payload)
    });
    if (token) localStorage.setItem("42spaceAdminToken", token);
    const monitors = Array.isArray(state.orderflowPayload?.monitors) ? state.orderflowPayload.monitors : [];
    state.orderflowPayload = {
      ...state.orderflowPayload,
      enabled: true,
      monitors: monitors.map((item) => item.id === data.monitor?.id ? data.monitor : item)
    };
    showToast(data.message || "Orderflow 监控已保存");
    renderOrderflowMonitors();
  } catch (error) {
    showToast(error.message || "Orderflow 监控保存失败");
    button.disabled = false;
    setButtonLabel(button, "send", "保存并重启");
  }
}

function evidencePreflightRows(evidence) {
  const readiness = evidence?.readiness;
  const firstBuy = evidence?.firstBuy;
  const rows = [];
  if (readiness) {
    rows.push({
      label: "Bot4 Readiness",
      value: readiness.ok
        ? `${phaseLabel(readiness.phase)} · OK`
        : `${readiness.failedCount ?? "?"} 项未通过`,
      tone: readiness.ok ? "good" : "bad"
    });
    rows.push({
      label: "自动卖出监控",
      value: readiness.autoSellMonitorStarted ? "已启动" : "未确认",
      tone: readiness.autoSellMonitorStarted ? "good" : "warn"
    });
  }
  if (firstBuy) {
    rows.push({
      label: "首次买入证据",
      value: firstBuy.conclusion === "complete"
        ? `Complete · ${firstBuy.txCount ?? 0} tx`
        : firstBuy.conclusion === "timeout"
          ? "Timeout"
          : `Pending · ${formatShortIso(firstBuy.expectedBroadcastIso)}`,
      tone: firstBuy.conclusion === "complete" ? "good" : firstBuy.conclusion === "timeout" ? "bad" : "warn"
    });
    const checks = firstBuy.checks ?? {};
    rows.push({
      label: "证据硬检查",
      value: evidenceCheckSummary(checks),
      tone: checks.noUnintendedBuys && checks.autoSellMonitorStarted && checks.stopLossConfigured ? "good" : "warn"
    });
  }
  return rows;
}

function evidenceCheckSummary(checks) {
  const passed = [
    checks.botRunning,
    checks.nextBatchKnown,
    checks.scheduledOnTime,
    checks.preSigned,
    checks.broadcasted,
    checks.broadcastStartedBefore20s,
    checks.firstAcceptedRpc,
    checks.outcomeOk,
    checks.receiptSuccess,
    checks.autoSellMonitorStarted,
    checks.stopLossConfigured,
    checks.noUnintendedBuys
  ].filter(Boolean).length;
  return `${passed}/12`;
}

function phaseLabel(value) {
  if (value === "pre_open") return "开盘前";
  if (value === "evidence_window") return "取证中";
  if (value === "post_evidence_window") return "取证后";
  return value || "--";
}

function formatShortIso(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
}

function setRuntimeConfigForm(config) {
  if (!config) return;
  els.configMode.value = config.filterMode ?? "price_only_test";
  renderDisplayFilterOptions(config);
  els.configOutcomeCount.value = config.eventOutcomeCount ?? 2;
  els.configStakePerOutcome.value = config.stakePerOutcomeUsdt ?? 1;
  els.configMaxBatchStake.value = config.maxBatchStakeUsdt ?? 20;
  els.configGasPriceGwei.value = config.gasPriceGwei ?? 2;
  els.configAutoSellGasPriceGwei.value = config.autoSellGasPriceGwei ?? "";
  els.configAutoSellEnabled.value = config.autoSellEnabled ? "1" : "0";
  els.configAutoSellStartDelay.value = config.autoSellStartDelaySeconds ?? 10;
  els.configAutoSellInterval.value = config.autoSellIntervalSeconds ?? 10;
  els.configAutoSellChunk.value = config.autoSellChunkPercent ?? 10;
  els.configAutoSellStopLossEnabled.value = config.autoSellStopLossEnabled ? "1" : "0";
  els.configAutoSellStopLoss.value = config.autoSellStopLossPercent ?? 10;
  els.configAutoSellStopLossSell.value = config.autoSellStopLossSellPercent ?? 100;
  syncSellModeFields(config.autoSellStrategy, runtimeSellModeLabel(config.autoSellStrategy), runtimeSellSummary(config));
}

function runtimeStatusText(config) {
  if (!config) return "--";
  const mode = config.filterMode === "price_only_test"
    ? "买入门槛：基础 Price/8hour 排除"
    : "买入门槛：基础排除+时长门槛";
  const filterCount = Array.isArray(config.eventDisplayFilterRules) ? config.eventDisplayFilterRules.length : 0;
  const filterText = filterCount ? `过滤${filterCount}项` : "显示全部";
  const sell = runtimeSellSummary(config);
  const sellGas = config.autoSellGasPriceGwei ? `卖 gas ${config.autoSellGasPriceGwei}` : "卖 gas 同买入";
  return `${mode} · ${filterText} · ${config.eventOutcomeCount} 档 · ${config.stakePerOutcomeUsdt}U/档 · 买 gas ${config.gasPriceGwei} · ${sellGas} · ${sell}`;
}

function syncSellModeFields(mode, label = null, summary = null) {
  const normalized = String(mode ?? "legacy").trim().toLowerCase();
  for (const field of document.querySelectorAll("[data-sell-config]")) {
    const supported = String(field.dataset.sellConfig ?? "").split(/\s+/u).filter(Boolean);
    field.hidden = !supported.includes(normalized);
  }
  if (els.configActiveSellMode) {
    const modeLabel = label || runtimeSellModeLabel(normalized);
    els.configActiveSellMode.innerHTML = `<span>当前卖出模式</span><strong>${escapeHtml(modeLabel)}</strong><p>${escapeHtml(summary || "")}</p>`;
  }
}

function runtimeSellModeLabel(mode) {
  if (mode === "open_timed_exit") return "开盘定时退出";
  if (mode === "pre_start_exit") return "赛前退出";
  if (mode === "ladder") return "阶梯卖出";
  return "Legacy 倍数止盈";
}

function runtimeSellSummary(config) {
  if (!config?.autoSellEnabled) return "自动卖出关闭";
  const mode = String(config.autoSellStrategy ?? "legacy");
  let main = "";
  if (mode === "open_timed_exit") {
    main = `开盘后 ${formatStrategyDuration(config.autoSellOpenExitDelaySeconds ?? 36)} 卖 ${formatPlainNumber(config.autoSellOpenExitPercent ?? 100)}%`;
    if (config.autoSellFastOpenExitEnabled) {
      main += `，快速窗口 T+${formatPlainNumber(Number(config.autoSellFastOpenExitMinDelayMs ?? 0) / 1000, 3)}-${formatPlainNumber(Number(config.autoSellFastOpenExitMaxDelayMs ?? 0) / 1000, 3)}s`;
    }
  } else if (mode === "pre_start_exit") {
    const beforeStart = Number(config.autoSellBeforeMarketStartSeconds ?? 0);
    main = beforeStart > 0 ? `赛前 ${formatStrategyDuration(beforeStart)} 清仓` : "赛前清仓时间未配置";
  } else if (mode === "ladder") {
    const profit = Number(config.autoSellLadderProfitPercent ?? 0);
    const gate = profit > 0 ? `盈利 ${formatPlainNumber(profit)}% 后` : `${formatStrategyDuration(config.autoSellStartDelaySeconds ?? 0)} 后`;
    const steps = Number(config.autoSellTakeProfitSteps ?? 0);
    main = steps > 0
      ? `${gate}卖 ${formatPlainNumber(config.autoSellChunkPercent ?? 0)}%，共 ${formatPlainNumber(steps)} 次`
      : `${gate}每 ${formatStrategyDuration(config.autoSellIntervalSeconds ?? 10)} 卖 ${formatPlainNumber(config.autoSellChunkPercent ?? 0)}%`;
  } else {
    main = `${formatPlainNumber(config.autoSellProfitMultiplier ?? 2)}x 卖 ${formatPlainNumber(config.autoSellPercent ?? 50)}%`;
  }
  const stop = config.autoSellStopLossEnabled
    ? `亏 ${formatPlainNumber(config.autoSellStopLossPercent ?? 10)}% ${Number(config.autoSellStopLossSellPercent ?? 100) >= 100 ? "全卖" : `卖 ${formatPlainNumber(config.autoSellStopLossSellPercent)}%`}`
    : "止损关闭";
  return `${main} / ${stop}`;
}

function formatStrategyDuration(value) {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds)) return "--";
  if (seconds >= 3600 && seconds % 3600 === 0) return `${formatPlainNumber(seconds / 3600)}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${formatPlainNumber(seconds / 60)}min`;
  return `${formatPlainNumber(seconds, 3)}s`;
}

function formatPlainNumber(value, decimals = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  if (Number.isInteger(number)) return String(number);
  return number.toFixed(decimals).replace(/0+$/u, "").replace(/\.$/u, "");
}

function renderDisplayFilterOptions(config) {
  if (!els.configDisplayFilters) return;
  const options = config.eventDisplayFilterRuleOptions
    ?? state.runtimeConfigEditable?.displayFilterRules
    ?? [];
  const enabled = new Set(config.eventDisplayFilterRules ?? []);
  els.configDisplayFilters.innerHTML = options.map((option) => `
    <label class="filterRuleOption">
      <input type="checkbox" name="configDisplayFilterRule" value="${escapeAttr(option.id)}" ${enabled.has(option.id) ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(option.label)}</strong>
        <span>${escapeHtml(option.description ?? "")}</span>
      </span>
    </label>
  `).join("");
}

function openSell(item) {
  state.selected = item;
  setSellPercent(100, { quote: false });
  els.sellTitle.innerHTML = `${icon("badge-dollar-sign")}<span>${item.all ? "一键卖出" : "卖出"}</span>`;
  els.sellOutcome.textContent = item.outcome;
  els.sellContext.innerHTML = `
    <div class="sellContextTitle" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</div>
    <div class="sellContextGrid">
      <div class="stat"><span>投入</span><strong>${item.cost} U</strong></div>
      <div class="stat"><span>筹码</span><strong>${item.chips}</strong></div>
      <div class="stat"><span>卖出</span><strong>${item.sold} U</strong></div>
      <div class="stat"><span>当前价值</span><strong>${item.value} U</strong></div>
      <div class="stat"><span>已实现</span><strong class="${signedTone(item.realized)}">${item.realized} U</strong></div>
      <div class="stat"><span>未实现</span><strong class="${signedTone(item.unrealized)}">${item.unrealized} U</strong></div>
      <div class="stat"><span>Gas</span><strong>${item.gas ?? "0"} U</strong></div>
      <div class="stat"><span>净盈亏</span><strong class="${item.positive ? "good" : "bad"}">${item.pnl} U</strong></div>
      <div class="stat"><span>收益</span><strong class="${item.positive ? "good" : "bad"}">${item.pnlPct}</strong></div>
    </div>
  `;
  els.quoteBox.innerHTML = `<div class="empty">报价中</div>`;
  setDrawerOpen(true);
  requestSellQuote();
}

function closeSell() {
  state.selected = null;
  state.quoteRequest += 1;
  clearTimeout(state.quoteTimer);
  setDrawerOpen(false);
}

async function requestSellQuote() {
  if (!state.selected) return;
  const requestId = ++state.quoteRequest;
  els.quoteBox.innerHTML = `<div class="empty">报价中</div>`;
  els.confirmSell.disabled = true;
  els.quoteRefresh.disabled = true;
  try {
    const data = await api("/api/sell/quote", {
      method: "POST",
      body: JSON.stringify(sellRequestBody())
    });
    if (requestId !== state.quoteRequest) return;
    renderQuote(data.quote);
    els.confirmSell.disabled = false;
  } catch (error) {
    if (requestId !== state.quoteRequest) return;
    els.quoteBox.innerHTML = `<div class="empty">${escapeHtml(error.message || "报价失败")}</div>`;
  } finally {
    if (requestId === state.quoteRequest) els.quoteRefresh.disabled = false;
  }
}

function renderQuote(quote) {
  els.quoteBox.innerHTML = `
    <div class="quoteIntro">
      <strong>${formatPercent(state.sellPercent)} 仓位</strong>
      <span>${escapeHtml(quote.outcome || state.selected?.outcome || "")}</span>
      ${quote.sellAmountOt ? `<span>卖出 ${escapeHtml(quote.sellAmountOt)} / ${escapeHtml(quote.balanceOt)} 筹码</span>` : ""}
    </div>
    <div class="quoteLine"><span>预计到账</span><strong>${quote.expected} U</strong></div>
    <div class="quoteLine"><span>最低到账</span><strong>${quote.minimum} U</strong></div>
    <div class="quoteLine"><span>费用</span><strong>${quote.fee} U</strong></div>
    ${quote.needsApproval ? `<div class="quoteLine"><span>首次卖出</span><strong>会多做一次授权</strong></div>` : ""}
  `;
}

async function executeSell() {
  if (!state.selected) return;
  els.confirmSell.disabled = true;
  els.quoteRefresh.disabled = true;
  setButtonLabel(els.confirmSell, "loader-circle", "卖出中");
  try {
    const data = await api("/api/sell/execute", {
      method: "POST",
      body: JSON.stringify(sellRequestBody())
    });
    showToast(`${data.sell.status}：${data.sell.receivedText} U`);
    closeSell();
    await loadOverview({ force: true });
  } catch (error) {
    showToast(error.message || "卖出失败");
  } finally {
    els.confirmSell.disabled = false;
    els.quoteRefresh.disabled = false;
    setButtonLabel(els.confirmSell, "send", `确认卖出 ${formatPercent(state.sellPercent)}`);
  }
}

function sellRequestBody() {
  const body = {
    market: state.selected.market,
    percent: state.sellPercent
  };
  if (state.selected.all) {
    body.all = true;
  } else {
    body.tokenId = state.selected.tokenId;
  }
  return body;
}

function setSellPercent(value, { quote = true } = {}) {
  const percent = clampPercent(value);
  state.sellPercent = percent;
  els.sellPercentText.textContent = formatPercent(percent);
  els.sellPercentRange.value = String(percent);
  els.sellPercentInput.value = String(percent);
  for (const button of document.querySelectorAll("[data-sell-percent]")) {
    button.classList.toggle("isActive", Number(button.dataset.sellPercent) === percent);
  }
  setButtonLabel(els.confirmSell, "send", `确认卖出 ${formatPercent(percent)}`);
  if (quote && state.selected) {
    clearTimeout(state.quoteTimer);
    state.quoteTimer = setTimeout(() => requestSellQuote(), 300);
  }
}

function setDrawerOpen(open) {
  els.sellDrawer.classList.toggle("isOpen", open);
  els.sellDrawer.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("drawerOpen", open);
}

function bindNavigation() {
  for (const button of document.querySelectorAll("[data-route]")) {
    button.addEventListener("click", () => {
      window.location.hash = `#/${button.dataset.route}`;
    });
  }
  for (const button of document.querySelectorAll("[data-upcoming-horizon]")) {
    button.addEventListener("click", () => {
      state.upcomingHorizonDays = Number(button.dataset.upcomingHorizon);
      for (const item of document.querySelectorAll("[data-upcoming-horizon]")) {
        item.classList.toggle("isActive", item === button);
      }
      if (state.data) renderNewMarkets(state.data.newMarkets);
    });
  }
  for (const button of document.querySelectorAll("[data-duration-filter]")) {
    button.addEventListener("click", () => {
      state.durationFilter = button.dataset.durationFilter;
      for (const item of document.querySelectorAll("[data-duration-filter]")) {
        item.classList.toggle("isActive", item === button);
      }
      if (state.data) renderNewMarkets(state.data.newMarkets);
    });
  }
  for (const button of document.querySelectorAll("[data-watch-lookback]")) {
    button.addEventListener("click", () => {
      state.watchedAddressLookbackMinutes = Number(button.dataset.watchLookback) || 60;
      for (const item of document.querySelectorAll("[data-watch-lookback]")) {
        item.classList.toggle("isActive", item === button);
      }
      loadWatchedAddressActivity();
    });
  }
  els.upcomingCategoryFilter?.addEventListener("change", () => {
    state.categoryFilter = els.upcomingCategoryFilter.value;
    if (state.data) renderNewMarkets(state.data.newMarkets);
  });
  els.selectAllUpcoming?.addEventListener("click", toggleAllUpcomingSelection);
  els.bulkFollowUpcoming?.addEventListener("click", () => saveMarketFollowBatch("follow"));
  els.bulkBlockUpcoming?.addEventListener("click", () => saveMarketFollowBatch("block"));
  els.toggleHistoryProjects?.addEventListener("click", () => {
    state.showHistoryProjects = !state.showHistoryProjects;
    if (state.data) renderProjectBoard(state.data.projectBoard);
  });
  document.addEventListener("click", (event) => {
    const selectInput = event.target.closest("[data-select-upcoming]");
    if (selectInput) {
      toggleUpcomingSelection(selectInput.dataset.selectUpcoming, selectInput.checked);
      return;
    }
    const marketButton = event.target.closest("[data-expand-market]");
    if (marketButton) {
      void toggleMarketExpansion(marketButton.dataset.expandMarket);
      return;
    }
    const projectButton = event.target.closest("[data-expand-project]");
    if (projectButton) {
      toggleProjectExpansion(projectButton.dataset.expandProject);
      return;
    }
    const historyProjectButton = event.target.closest("[data-expand-history-project]");
    if (historyProjectButton) {
      toggleHistoryProjectExpansion(historyProjectButton.dataset.expandHistoryProject);
      return;
    }
    const followButton = event.target.closest("[data-follow-action]");
    if (followButton) {
      void saveMarketFollow(followButton);
    }
  });
}

function toggleUpcomingSelection(address, selected) {
  const key = marketSelectionKey(address);
  if (!key) return;
  if (selected) {
    state.selectedUpcomingMarkets.add(key);
  } else {
    state.selectedUpcomingMarkets.delete(key);
  }
  renderUpcomingBulkControls();
}

function toggleAllUpcomingSelection() {
  const items = state.visibleUpcomingMarkets.length ? state.visibleUpcomingMarkets : upcomingVisibleItems();
  const keys = [...visibleUpcomingKeys(items)];
  const allSelected = keys.length > 0 && keys.every((key) => state.selectedUpcomingMarkets.has(key));
  for (const key of keys) {
    if (allSelected) {
      state.selectedUpcomingMarkets.delete(key);
    } else {
      state.selectedUpcomingMarkets.add(key);
    }
  }
  if (state.data) renderNewMarkets(state.data.newMarkets);
}

async function toggleMarketExpansion(address) {
  if (!address) return;
  if (state.expandedMarkets.has(address)) {
    state.expandedMarkets.delete(address);
    if (state.data) renderNewMarkets(state.data.newMarkets);
    return;
  }
  state.expandedMarkets.add(address);
  if (state.data) renderNewMarkets(state.data.newMarkets);
  if (!state.marketDetails.has(address)) {
    try {
      const detail = await api(`/api/market-detail?market=${encodeURIComponent(address)}`);
      state.marketDetails.set(address, detail);
    } catch (error) {
      state.marketDetails.set(address, { error: error.message || "读取失败" });
    }
  }
  if (state.data) renderNewMarkets(state.data.newMarkets);
}

function toggleProjectExpansion(address) {
  if (!address) return;
  if (state.projectExpanded.has(address)) {
    state.projectExpanded.delete(address);
  } else {
    state.projectExpanded.add(address);
  }
  if (state.data) renderProjectBoard(state.data.projectBoard);
}

function toggleHistoryProjectExpansion(address) {
  if (!address) return;
  if (state.historyExpanded.has(address)) {
    state.historyExpanded.delete(address);
  } else {
    state.historyExpanded.add(address);
  }
  if (state.data) renderProjectBoard(state.data.projectBoard);
}

async function saveMarketFollow(button) {
  let payload = {};
  try {
    payload = JSON.parse(button.dataset.market || "{}");
  } catch {
    showToast("市场数据无效");
    return;
  }
  const action = button.dataset.followAction === "block" ? "block" : "follow";
  button.disabled = true;
  try {
    const data = await api("/api/market-follow", {
      method: action === "block" ? "DELETE" : "POST",
      body: JSON.stringify({ ...payload, action })
    });
    showToast(data.message || (action === "block" ? "已取消关注" : "已关注"));
    await loadOverview({ force: true });
  } catch (error) {
    showToast(error.message || "关注状态保存失败");
  } finally {
    button.disabled = false;
  }
}

async function saveMarketFollowBatch(action) {
  const selectedItems = state.visibleUpcomingMarkets.filter((item) => state.selectedUpcomingMarkets.has(marketSelectionKey(item)));
  if (!selectedItems.length) {
    showToast("先选择市场");
    return;
  }
  state.upcomingBulkBusy = true;
  renderUpcomingBulkControls();
  try {
    const data = await api("/api/market-follow-batch", {
      method: "POST",
      body: JSON.stringify({
        action,
        markets: selectedItems.map(followPayload)
      })
    });
    state.selectedUpcomingMarkets.clear();
    showToast(data.message || (action === "block" ? `已取消关注 ${selectedItems.length} 个` : `已关注 ${selectedItems.length} 个`));
    await loadOverview({ force: true });
  } catch (error) {
    showToast(error.message || "批量关注状态保存失败");
  } finally {
    state.upcomingBulkBusy = false;
    renderUpcomingBulkControls();
  }
}

function bindSellControls() {
  els.closeDialog.addEventListener("click", closeSell);
  els.sellBackdrop.addEventListener("click", closeSell);
  els.confirmSell.addEventListener("click", executeSell);
  els.quoteRefresh.addEventListener("click", requestSellQuote);
  els.sellPercentRange.addEventListener("input", () => setSellPercent(els.sellPercentRange.value));
  els.sellPercentInput.addEventListener("input", () => setSellPercent(els.sellPercentInput.value));
  for (const button of document.querySelectorAll("[data-sell-percent]")) {
    button.addEventListener("click", () => setSellPercent(button.dataset.sellPercent));
  }
}

function bindRuntimeConfigControls() {
  if (!els.runtimeConfigForm) return;
  const token = localStorage.getItem("42spaceAdminToken") ?? "";
  if (els.configAdminToken) els.configAdminToken.value = token;
  for (const input of [
    els.configMode,
    els.configOutcomeCount,
    els.configStakePerOutcome,
    els.configMaxBatchStake,
    els.configGasPriceGwei,
    els.configAutoSellGasPriceGwei,
    els.configAutoSellEnabled,
    els.configAutoSellStartDelay,
    els.configAutoSellInterval,
    els.configAutoSellChunk,
    els.configAutoSellStopLossEnabled,
    els.configAutoSellStopLoss,
    els.configAutoSellStopLossSell
  ]) {
    input.addEventListener("input", () => {
      state.configDirty = true;
      els.configStatus.textContent = "未应用";
    });
  }
  els.configDisplayFilters?.addEventListener("change", () => {
    state.configDirty = true;
    els.configStatus.textContent = "未应用";
  });
  els.configAdminToken?.addEventListener("input", () => {
    localStorage.setItem("42spaceAdminToken", els.configAdminToken.value);
  });
  els.runtimeConfigForm.addEventListener("submit", saveRuntimeConfig);
}

function bindPriceExitControls() {
  if (!els.priceExitPanel) return;
  els.priceExitRows?.addEventListener("input", updatePriceExitDraftFromInput);
  els.priceExitRows?.addEventListener("change", updatePriceExitDraftFromInput);
  els.priceExitRows?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-price-exit-remove]");
    if (!button) return;
    const index = Number(button.dataset.priceExitRemove);
    if (!Number.isInteger(index) || index < 0 || index >= state.priceExitDraft.length) return;
    state.priceExitDraft.splice(index, 1);
    markPriceExitDirty();
    renderPriceExitRows();
  });
  els.addPriceExitTarget?.addEventListener("click", () => {
    const used = new Set(state.priceExitDraft.map((target) => normalizeText(target.outcome)));
    const outcome = (state.priceExitPayload?.outcomes ?? []).find((item) => !used.has(normalizeText(item)));
    if (!outcome) {
      showToast("当前计划没有可添加的 outcome");
      return;
    }
    state.priceExitDraft.push({ outcome, price: "0.001", enabled: true });
    markPriceExitDirty();
    renderPriceExitRows();
  });
  els.priceExitApplyExisting?.addEventListener("change", markPriceExitDirty);
  els.priceExitAdminToken?.addEventListener("input", () => {
    const token = els.priceExitAdminToken.value;
    localStorage.setItem("42spaceAdminToken", token);
    if (els.configAdminToken) els.configAdminToken.value = token;
  });
  els.savePriceExitConfig?.addEventListener("click", savePriceExitConfig);
}

function updatePriceExitDraftFromInput(event) {
  const input = event.target.closest("[data-price-exit-field]");
  if (!input) return;
  const row = input.closest("[data-price-exit-index]");
  const index = Number(row?.dataset.priceExitIndex);
  if (!Number.isInteger(index) || !state.priceExitDraft[index]) return;
  const field = input.dataset.priceExitField;
  state.priceExitDraft[index][field] = field === "enabled" ? input.checked : input.value;
  markPriceExitDirty();
  if (field !== "price") renderPriceExitRows();
}

function markPriceExitDirty() {
  state.priceExitDirty = true;
  if (els.priceExitMessage) els.priceExitMessage.textContent = "未应用";
}

async function savePriceExitConfig() {
  const payload = state.priceExitPayload;
  if (!payload?.enabled) return;
  const token = els.priceExitAdminToken?.value.trim() || els.configAdminToken?.value.trim() || localStorage.getItem("42spaceAdminToken") || "";
  if (state.priceExitWriteProtected && !token) {
    showToast("需要管理令牌");
    return;
  }
  const targets = state.priceExitDraft.map((target) => ({
    outcome: target.outcome,
    price: String(target.price).trim(),
    enabled: target.enabled !== false
  }));
  if (targets.some((target) => !(Number(target.price) > 0 && Number(target.price) <= 1))) {
    showToast("卖出阈值必须大于 0 且不超过 1");
    return;
  }
  const applyToExisting = Boolean(els.priceExitApplyExisting?.checked);
  const reachesExisting = applyToExisting && targets.some((target) => {
    const current = (payload.targets ?? []).find((item) => normalizeText(item.outcome) === normalizeText(target.outcome));
    return target.enabled && Number.isFinite(Number(current?.currentPrice)) && Number(current.currentPrice) >= Number(target.price);
  });
  if (reachesExisting && !window.confirm("当前持仓已经达到至少一个价格阈值，应用后可能立即卖出。继续应用？")) return;

  els.savePriceExitConfig.disabled = true;
  try {
    const data = await api("/api/planned-price-exit", {
      method: "PUT",
      headers: token ? { "x-admin-token": token } : {},
      body: JSON.stringify({ planId: payload.plan?.id, targets, applyToExisting })
    });
    state.priceExitPayload = data;
    state.priceExitWriteProtected = Boolean(data.writeProtected);
    state.priceExitDraft = (data.targets ?? []).map((target) => ({
      outcome: target.outcome,
      price: String(target.price),
      enabled: target.enabled !== false
    }));
    state.priceExitDirty = false;
    if (token) localStorage.setItem("42spaceAdminToken", token);
    renderPriceExitConfig();
    syncAdminTokenField();
    showToast(data.message || "价格配置已应用");
    await loadOverview({ force: true });
  } catch (error) {
    showToast(error.message || "价格配置保存失败");
  } finally {
    els.savePriceExitConfig.disabled = false;
  }
}

function syncAdminTokenField() {
  const field = els.configAdminToken?.closest(".field");
  if (field) field.hidden = !state.runtimeWriteProtected;
  if (els.priceExitAdminField) els.priceExitAdminField.hidden = !state.priceExitWriteProtected;
  const token = localStorage.getItem("42spaceAdminToken") ?? "";
  if (els.configAdminToken && !els.configAdminToken.value) els.configAdminToken.value = token;
  if (els.priceExitAdminToken && !els.priceExitAdminToken.value) els.priceExitAdminToken.value = token;
}

async function saveRuntimeConfig(event) {
  event.preventDefault();
  const token = els.configAdminToken?.value.trim() ?? "";
  if (state.runtimeWriteProtected && !token) {
    showToast("需要管理令牌");
    return;
  }
  const payload = {
    filterMode: els.configMode.value,
    eventOutcomeCount: Number(els.configOutcomeCount.value),
    stakePerOutcomeUsdt: Number(els.configStakePerOutcome.value),
    maxBatchStakeUsdt: Number(els.configMaxBatchStake.value),
    gasPriceGwei: String(els.configGasPriceGwei.value),
    autoSellGasPriceGwei: String(els.configAutoSellGasPriceGwei.value).trim(),
    autoSellEnabled: els.configAutoSellEnabled.value === "1",
    autoSellStartDelaySeconds: Number(els.configAutoSellStartDelay.value),
    autoSellIntervalSeconds: Number(els.configAutoSellInterval.value),
    autoSellChunkPercent: Number(els.configAutoSellChunk.value),
    autoSellStopLossEnabled: els.configAutoSellStopLossEnabled.value === "1",
    autoSellStopLossPercent: Number(els.configAutoSellStopLoss.value),
    autoSellStopLossSellPercent: Number(els.configAutoSellStopLossSell.value),
    eventDisplayFilterRules: selectedDisplayFilterRules()
  };
  els.saveConfigBtn.disabled = true;
  try {
    const data = await api("/api/runtime-config", {
      method: "PUT",
      headers: token ? { "x-admin-token": token } : {},
      body: JSON.stringify(payload)
    });
    state.configDirty = false;
    state.runtimeConfig = data.config;
    if (token) localStorage.setItem("42spaceAdminToken", token);
    setRuntimeConfigForm(data.config);
    els.configStatus.textContent = runtimeStatusText(data.config);
    showToast(data.message || "配置已应用");
    await loadOverview({ force: true });
  } catch (error) {
    showToast(error.message || "配置保存失败");
  } finally {
    els.saveConfigBtn.disabled = false;
  }
}

function selectedDisplayFilterRules() {
  return [...(els.configDisplayFilters?.querySelectorAll("input[name='configDisplayFilterRule']:checked") ?? [])]
    .map((input) => input.value)
    .filter(Boolean);
}

function setRoute(route, { replace = false } = {}) {
  const nextRoute = ROUTES[route] ? route : "overview";
  state.route = nextRoute;
  if (!replace && window.location.hash !== `#/${nextRoute}`) window.location.hash = `#/${nextRoute}`;
  document.body.dataset.route = nextRoute;
  for (const button of document.querySelectorAll("[data-route]")) {
    button.classList.toggle("isActive", button.dataset.route === nextRoute);
  }
  for (const view of document.querySelectorAll("[data-view]")) {
    view.classList.toggle("isActive", view.dataset.view === nextRoute);
  }
  const copy = ROUTES[nextRoute];
  els.viewKicker.textContent = copy.kicker;
  els.viewTitle.textContent = copy.title;
  els.viewLead.textContent = copy.lead;
  if (nextRoute === "watchlist") loadWatchedAddressActivity();
}

function routeFromHash() {
  return window.location.hash.replace(/^#\/?/, "") || "overview";
}

function marketStateTone(tone) {
  if (tone === "good") return "stateGood";
  if (tone === "warn") return "stateWarn";
  if (tone === "bad") return "stateBad";
  return "stateNeutral";
}

function signedTone(value) {
  return String(value ?? "").trim().startsWith("-") ? "bad" : "good";
}

function summaryCard(label, value, meta, positive) {
  return `
    <div class="summaryCard">
      <span>${escapeHtml(label)}</span>
      <strong class="${positive ? "goodish" : "bad"}">${escapeHtml(value)}</strong>
      <small class="${positive ? "good" : "bad"}">${escapeHtml(meta)}</small>
    </div>
  `;
}

function splitActivityTitle(value) {
  const parts = String(value ?? "").split(" / ");
  return {
    main: parts[0] ?? "",
    detail: parts.slice(1).join(" / ")
  };
}

function activityTone(label) {
  if (label === "卖出" || label === "手动卖出" || label === "自动卖出" || label === "结算") return "sell";
  if (label === "买入" || label === "买入成功") return "buy";
  if (label === "买入失败" || label === "禁止买入") return "badTone";
  if (label === "等待确认") return "wait";
  return "neutral";
}

function updateCountdowns() {
  if (els.nextClock.dataset.startsAt) {
    els.nextClock.textContent = countdown(els.nextClock.dataset.startsAt);
  } else {
    els.nextClock.textContent = "--";
  }
  for (const el of document.querySelectorAll("[data-countdown]")) {
    el.textContent = countdown(el.dataset.countdown);
  }
}

async function api(url, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(url, {
    ...rest,
    headers: { "content-type": "application/json", ...headers }
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.message || "请求失败");
  return data;
}

function countdown(value) {
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff)) return "--";
  if (diff <= 0) return "已开";
  const total = Math.floor(diff / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}天 ${hours}时`;
  if (hours > 0) return `${hours}时 ${mins}分`;
  return `${mins}分 ${secs}秒`;
}

function formatDate(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatMoneyShort(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  const sign = number > 0 ? "+" : "";
  const abs = Math.abs(number);
  if (abs >= 1000) return `${sign}${(number / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (abs >= 10) return `${sign}${number.toFixed(1).replace(/\.0$/, "")}`;
  return `${sign}${number.toFixed(2).replace(/\.?0+$/, "")}`;
}

function formatInteger(value, options = {}) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  const rounded = Math.round(number);
  const positiveSign = options.positiveSign ?? true;
  return `${positiveSign && rounded > 0 ? "+" : ""}${rounded}`;
}

function shortAddressText(value) {
  const text = String(value ?? "");
  return text.length > 12 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function shortHashText(value) {
  const text = String(value ?? "");
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.min(100, Math.max(1, Math.round(number)));
}

function formatPercent(value) {
  return `${clampPercent(value)}%`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function renderStaticIcons() {
  for (const el of document.querySelectorAll("[data-icon]")) {
    el.innerHTML = icon(el.dataset.icon);
  }
}

function setButtonLabel(button, iconName, label) {
  button.innerHTML = `${icon(iconName)}<span>${escapeHtml(label)}</span>`;
}

function icon(name, className = "icon") {
  const body = ICONS[name] ?? "";
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
