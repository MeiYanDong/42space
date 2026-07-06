export const EVENT_DISPLAY_FILTER_RULES = Object.freeze([
  {
    id: "price",
    label: "价格",
    description: "BTC Price/8hour/clock curve 事件"
  },
  {
    id: "daily_fixed_template",
    label: "日常固定模板",
    description: "期货每日交易量、OpenRouter 每日代币、World Cup 单日总进球等"
  },
  {
    id: "sports_total_goals",
    label: "总进球数",
    description: "FIFA/Sports Total Goals、Total Score、總進球數"
  },
  {
    id: "sports_goal_differential",
    label: "净胜球数",
    description: "FIFA/Sports Goal Differential、Score Different、净胜球數"
  }
]);

export const DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS = Object.freeze(EVENT_DISPLAY_FILTER_RULES.map((rule) => rule.id));

const EVENT_DISPLAY_FILTER_RULE_ID_SET = new Set(DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS);

export function normalizeEventDisplayFilterRules(value, { fallback = DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS } = {}) {
  if (value === undefined || value === null) return fallback === null ? null : [...fallback];
  const list = Array.isArray(value)
    ? value
    : String(value).split(",");
  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item ?? "").trim();
    if (!id || !EVENT_DISPLAY_FILTER_RULE_ID_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function eventDisplayFilterRuleOptions() {
  return EVENT_DISPLAY_FILTER_RULES.map((rule) => ({ ...rule }));
}

export function eventDisplayFilterRuleLabels(ruleIds) {
  const enabled = new Set(normalizeEventDisplayFilterRules(ruleIds));
  return EVENT_DISPLAY_FILTER_RULES
    .filter((rule) => enabled.has(rule.id))
    .map((rule) => rule.label);
}

export function eventDisplayFilterRuleLabel(ruleId) {
  return EVENT_DISPLAY_FILTER_RULES.find((rule) => rule.id === ruleId)?.label ?? String(ruleId ?? "");
}
