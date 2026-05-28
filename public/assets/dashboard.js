const ROUTES = {
  overview: {
    kicker: "Today",
    title: "Overview",
    lead: "判断当前 bot 是否需要人工干预。"
  },
  markets: {
    kicker: "Discovery",
    title: "Markets",
    lead: "查看新盘、待开盘队列和 bot 的买入决策。"
  },
  positions: {
    kicker: "Portfolio",
    title: "Positions",
    lead: "管理 bot wallet 当前持仓，并按比例报价卖出。"
  },
  execution: {
    kicker: "Audit",
    title: "Execution",
    lead: "复盘链上活动、本地执行结果和失败原因。"
  },
  strategy: {
    kicker: "Preflight",
    title: "Strategy",
    lead: "检查 watch config、资金状态和实盘前置条件。"
  }
};

const state = {
  data: null,
  route: routeFromHash(),
  marketFilter: "all",
  marketTimeFilter: "all",
  selected: null,
  sellPercent: 100,
  quoteRequest: 0,
  quoteTimer: null,
  timer: null
};

const ICONS = {
  activity: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>`,
  "badge-dollar-sign": `<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"></path><path d="M12 7v10"></path><path d="M15 9.5A3.5 3.5 0 0 0 12 8a2.5 2.5 0 0 0 0 5 2.5 2.5 0 0 1 0 5 3.5 3.5 0 0 1-3-1.5"></path>`,
  "bar-chart-3": `<path d="M3 3v18h18"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path>`,
  "calendar-clock": `<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"></path><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h5"></path><circle cx="16" cy="16" r="6"></circle><path d="M16 14v2l1.5 1.5"></path>`,
  "circle-dollar-sign": `<circle cx="12" cy="12" r="10"></circle><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"></path><path d="M12 18V6"></path>`,
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
  refreshBtn: $("refreshBtn"),
  viewKicker: $("viewKicker"),
  viewTitle: $("viewTitle"),
  viewLead: $("viewLead"),
  botState: $("botState"),
  fundingState: $("fundingState"),
  nextClock: $("nextClock"),
  newMarketCount: $("newMarketCount"),
  newMarketList: $("newMarketList"),
  nextCount: $("nextCount"),
  upcomingList: $("upcomingList"),
  holdingCount: $("holdingCount"),
  holdingsList: $("holdingsList"),
  positionSummary: $("positionSummary"),
  projectCount: $("projectCount"),
  projectStats: $("projectStats"),
  activityList: $("activityList"),
  attentionList: $("attentionList"),
  overviewSnapshot: $("overviewSnapshot"),
  overviewNextAction: $("overviewNextAction"),
  overviewActivityMini: $("overviewActivityMini"),
  stakeText: $("stakeText"),
  windowText: $("windowText"),
  autoSellText: $("autoSellText"),
  preflightList: $("preflightList"),
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
setRoute(state.route, { replace: true });

els.refreshBtn.addEventListener("click", () => loadOverview({ force: true }));
window.addEventListener("hashchange", () => setRoute(routeFromHash(), { replace: true }));

loadOverview();
state.timer = setInterval(() => {
  updateCountdowns();
  loadOverview();
}, 5000);
setInterval(updateCountdowns, 1000);

async function loadOverview({ force = false } = {}) {
  if (force) els.refreshBtn.disabled = true;
  try {
    const data = await api("/api/overview");
    state.data = data;
    render(data);
  } catch (error) {
    showToast(error.message || "刷新失败");
  } finally {
    els.refreshBtn.disabled = false;
  }
}

function render(data) {
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
    ${summaryCard("总盈亏", `${cards.totalPnl} U`, cards.totalRoi, cards.totalPositive)}
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
  renderNext(data.next);
  renderNewMarkets(data.newMarkets);
}

function renderNewMarkets(feed) {
  const items = feed.items
    .filter((item) => marketMatchesFilter(item, state.marketFilter))
    .filter((item) => marketMatchesTimeFilter(item, state.marketTimeFilter));
  const baseCount = feed.excluded ? `${feed.count} 个 · 排除 ${feed.excluded}` : `${feed.count} 个`;
  els.newMarketCount.textContent = state.marketFilter === "all" && state.marketTimeFilter === "all"
    ? baseCount
    : `${items.length} / ${feed.count}`;
  if (!items.length) {
    els.newMarketList.innerHTML = `<div class="empty">暂无匹配市场</div>`;
    return;
  }
  els.newMarketList.innerHTML = marketSections(items).map((section) => `
    <section class="marketSection">
      <div class="marketSectionHead">
        <strong>${escapeHtml(section.label)}</strong>
        <span>${section.items.length} 场</span>
      </div>
      ${marketTable(section.items)}
    </section>
  `).join("");
}

function marketTable(items) {
  return `
    <div class="tableHeader marketRow">
      <span>Market</span>
      <span>Time</span>
      <span>State</span>
      <span>Stake</span>
    </div>
    ${items.map((item) => `
      <div class="marketRow">
        <div class="marketQuestion">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${item.category ? escapeHtml(item.category) : "Event Market"} · 买 ${item.choices} 档</small>
          <div class="tagLine">${(item.tags || []).map((tag) => `<span class="miniTag">${escapeHtml(tag)}</span>`).join("")}</div>
          ${item.filterReason ? `<small class="filterReason">${escapeHtml(item.filterReason)}</small>` : ""}
        </div>
        <div class="timeCell">
          <small>新出 ${formatDate(item.createdAt)}</small>
          <strong>${formatDate(item.startsAt)}</strong>
          <span>${formatDate(item.endsAt)}</span>
          <small>${escapeHtml(item.duration || "")}</small>
        </div>
        <div><span class="marketState ${marketStateTone(item.tone)}">${escapeHtml(item.state)}</span></div>
        <div>${item.stake} U</div>
      </div>
    `).join("")}
  `;
}

function marketSections(items) {
  if (state.marketTimeFilter !== "all") {
    return [{
      label: state.marketTimeFilter === "future" ? "未来开盘" : "已经开盘",
      items
    }];
  }
  const past = items.filter((item) => item.timeGroup === "past");
  const future = items.filter((item) => item.timeGroup === "future");
  const unknown = items.filter((item) => item.timeGroup !== "past" && item.timeGroup !== "future");
  return [
    { label: "已经开盘", items: past },
    { label: "未来开盘", items: future },
    { label: "时间未知", items: unknown }
  ].filter((section) => section.items.length);
}

function renderNext(next) {
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

function renderPositions(data) {
  const cards = data.analytics.cards;
  els.positionSummary.innerHTML = `
    ${summaryCard("投入", `${cards.invested} U`, "累计买入", true)}
    ${summaryCard("卖出", `${cards.totalSold} U`, "累计收回", true)}
    ${summaryCard("当前", `${cards.openValue} U`, `${data.holdings.count} 个可卖`, true)}
    ${summaryCard("已实现", `${cards.realizedPnl} U`, "已卖出盈亏", cards.realizedPositive)}
    ${summaryCard("未实现", `${cards.unrealizedPnl} U`, "当前浮盈亏", cards.unrealizedPositive)}
    ${summaryCard("总盈亏", `${cards.totalPnl} U`, cards.totalRoi, cards.totalPositive)}
  `;
  renderHoldings(data.holdings);
  renderProjectStats(data.analytics.projects);
}

function renderHoldings(holdings) {
  els.holdingCount.textContent = `${holdings.count} 个`;
  const sellBlocked = Boolean(state.data?.manualSell?.blocked);
  const sellBlockMessage = state.data?.manualSell?.message ?? "";
  if (!holdings.groups.length) {
    els.holdingsList.innerHTML = `<div class="empty">暂无</div>`;
    return;
  }
  els.holdingsList.innerHTML = holdings.groups.map((group) => `
    <section class="marketGroup">
      <div class="marketTop">
        <div>
          <div class="marketTitle" title="${escapeAttr(group.title)}">${escapeHtml(group.title)}</div>
          <div class="marketMeta">投入 ${group.cost} U · 卖出 ${group.sold} U · 当前 ${group.value} U · 已实现 ${group.realized} U · 未实现 ${group.unrealized} U</div>
        </div>
        <div class="marketActions">
          <strong class="${group.positive ? "good" : "bad"}">${group.pnl} U</strong>
          <button
            class="sellAllBtn iconButton"
            data-sell='${escapeAttr(JSON.stringify(groupSellItem(group)))}'
            title="${escapeAttr(sellBlocked ? sellBlockMessage : "卖出该事件全部持仓")}"
            ${group.sellable && !sellBlocked ? "" : "disabled"}
          >${icon("badge-dollar-sign")}<span>一键卖出</span></button>
        </div>
      </div>
      <div class="positionTable">
        ${group.items.map((item) => renderPosition(item, { sellBlocked, sellBlockMessage })).join("")}
      </div>
    </section>
  `).join("");

  for (const button of document.querySelectorAll("[data-sell]")) {
    button.addEventListener("click", () => openSell(JSON.parse(button.dataset.sell)));
  }
}

function groupSellItem(group) {
  return {
    all: true,
    market: group.market,
    title: group.title,
    outcome: "全部选项",
    chips: `${group.sellableCount} 个选项`,
    cost: group.cost,
    sold: group.sold,
    value: group.value,
    realized: group.realized,
    unrealized: group.unrealized,
    pnl: group.pnl,
    pnlPct: "",
    positive: group.positive,
    sellable: group.sellable
  };
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
        <div class="stat"><span>卖出</span><strong>${item.sold} U</strong></div>
        <div class="stat"><span>当前</span><strong>${item.value} U</strong></div>
        <div class="stat"><span>已实现</span><strong class="${signedTone(item.realized)}">${item.realized} U</strong></div>
        <div class="stat"><span>未实现</span><strong class="${signedTone(item.unrealized)}">${item.unrealized} U</strong></div>
        <div class="stat"><span>总盈亏</span><strong class="${item.positive ? "good" : "bad"}">${item.pnl} U</strong></div>
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

function renderProjectStats(projects) {
  els.projectCount.textContent = `${projects.length} 个`;
  if (!projects.length) {
    els.projectStats.innerHTML = `<div class="empty">暂无</div>`;
    return;
  }
  els.projectStats.innerHTML = projects.map((project) => `
    <div class="projectRow">
      <div class="projectTitle" title="${escapeAttr(project.title)}">${escapeHtml(project.title)}</div>
      <div class="projectNums">
        <div class="stat"><span>买入</span><strong>${project.bought} U</strong></div>
        <div class="stat"><span>卖出</span><strong>${project.sold} U</strong></div>
        <div class="stat"><span>当前</span><strong>${project.openValue} U</strong></div>
        <div class="stat"><span>已实现</span><strong class="${project.realizedPositive ? "good" : "bad"}">${project.realized} U</strong></div>
        <div class="stat"><span>未实现</span><strong class="${project.unrealizedPositive ? "good" : "bad"}">${project.unrealized} U</strong></div>
        <div class="stat"><span>总盈亏</span><strong class="${project.positive ? "good" : "bad"}">${project.pnl} U</strong></div>
        <div class="stat"><span>收益</span><strong class="${project.positive ? "good" : "bad"}">${project.roi}</strong></div>
      </div>
    </div>
  `).join("");
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
  els.stakeText.textContent = data.settings?.stakeText ?? "--";
  els.windowText.textContent = data.settings?.windowText ?? "--";
  els.autoSellText.textContent = data.settings?.autoSellText ?? "--";
  const checks = [
    { label: "运行状态", value: data.bot.label, tone: data.bot.tone },
    { label: "资金状态", value: data.wallet ? `${data.wallet.label} · ${data.wallet.busdt} U / ${data.wallet.bnb} BNB` : "--", tone: data.wallet?.tone ?? "warn" },
    { label: "手动卖出", value: data.manualSell?.label ?? "--", tone: data.manualSell?.blocked ? "warn" : "good" },
    { label: "下一批市场", value: `${data.next.count} 场`, tone: data.next.count ? "warn" : "neutral" },
    { label: "持仓数量", value: `${data.holdings.count} 个`, tone: data.holdings.count ? "good" : "neutral" }
  ];
  els.preflightList.innerHTML = checks.map((check) => `
    <div class="preflightRow">
      <span>${escapeHtml(check.label)}</span>
      <strong class="${check.tone}">${escapeHtml(check.value)}</strong>
    </div>
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
      <div class="stat"><span>总盈亏</span><strong class="${item.positive ? "good" : "bad"}">${item.pnl} U</strong></div>
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
  for (const button of document.querySelectorAll("[data-market-filter]")) {
    button.addEventListener("click", () => {
      state.marketFilter = button.dataset.marketFilter;
      for (const item of document.querySelectorAll("[data-market-filter]")) {
        item.classList.toggle("isActive", item === button);
      }
      if (state.data) renderNewMarkets(state.data.newMarkets);
    });
  }
  for (const button of document.querySelectorAll("[data-market-time]")) {
    button.addEventListener("click", () => {
      state.marketTimeFilter = button.dataset.marketTime;
      for (const item of document.querySelectorAll("[data-market-time]")) {
        item.classList.toggle("isActive", item === button);
      }
      if (state.data) renderNewMarkets(state.data.newMarkets);
    });
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
}

function routeFromHash() {
  return window.location.hash.replace(/^#\/?/, "") || "overview";
}

function marketMatchesFilter(item, filter) {
  if (filter === "all") return true;
  if (filter === "bought") return item.state === "已买";
  if (filter === "skipped") return item.state === "已跳过" || item.state === "已错过";
  if (filter === "filtered") return item.state === "已过滤";
  if (filter === "funding") return item.state === "资金不足";
  if (filter === "pending") return !["已买", "已跳过", "已错过", "已过滤", "资金不足"].includes(item.state);
  return true;
}

function marketMatchesTimeFilter(item, filter) {
  if (filter === "all") return true;
  return item.timeGroup === filter;
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
  if (label === "卖出" || label === "手动卖出" || label === "自动卖出") return "sell";
  if (label === "买入" || label === "买入成功") return "buy";
  if (label === "买入失败") return "badTone";
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
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
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
