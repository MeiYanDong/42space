#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendJsonl, loadSeen, parseArgs, readConfig, saveSeen } from "./config.js";
import {
  DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS,
  normalizeEventDisplayFilterRules
} from "./event-display-rules.js";
import { ADDRESSES, fetchMarket } from "./fortytwo.js";

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_SEARCH_WINDOW_HOURS = 24;
const DEFAULT_CREATED_AT_OPEN_THRESHOLD_MINUTES = 31;
const DEFAULT_TWITTERAPI_IO_BASE_URL = "https://api.twitterapi.io";
const DEFAULT_X_QUERY_TYPE = "Latest";
const DEFAULT_TEMPLATE_REGEX = [
  "Futures Daily Volume",
  "Daily Token Usage",
  "highest .* usage on OpenRouter",
  "Weekly .*Notional Volume",
  "Monthly .*Notional Volume",
  "HIP-[34] total volume",
  "price range.*8:00 AM UTC",
  "World Cup: Total goals scored in one day",
  "期[貨货]每日交易量",
  "每日(?:成交量|交易量)",
  "每日代[幣币](?:(?:總|总)?使用量|使用(?:總|总)?量)",
  "(?:透過|通过)\\s*OpenRouter.*每日代[幣币]",
  "AI\\s*模型.*OpenRouter.*Python.*使用量.*最高"
].join("|");

const BINANCE_TERMS = [
  "币安",
  "binance",
  "bnb",
  "bnb chain",
  "bnbchain",
  "binance alpha",
  "binance wallet",
  "launchpool",
  "megadrop",
  "cz",
  "changpeng",
  "yi he",
  "he yi"
];

const BINANCE_OFFICIAL_USERNAMES = new Set([
  "binance",
  "cz_binance",
  "heyibinance",
  "bnbchain",
  "binancewallet",
  "binancezh",
  "binance_cn",
  "binance_chinese"
]);

const BINANCE_DOMAINS = [
  "binance.com",
  "binance.info",
  "bnbchain.org"
];

const BINANCE_STRONG_URL_PATTERNS = [
  /\/(?:[a-z]{2}\/)?support\/announcement\b/iu,
  /\/(?:[a-z]{2}\/)?alpha\b/iu,
  /\/(?:[a-z]{2}\/)?wallet\b/iu,
  /\/(?:[a-z]{2}\/)?launchpool\b/iu,
  /\/(?:[a-z]{2}\/)?megadrop\b/iu,
  /\/(?:[a-z]{2}\/)?listing\b/iu
];

const BINANCE_STRONG_TOPIC_RULES = [
  {
    label: "Binance 上币/上市题目",
    pattern: /\b(?:listed|listing|lists?|launched|launching)\s+(?:on|at|in)\s+binance\b|\bbinance\s+(?:listing|listed|lists?|launchpool|megadrop)\b/iu
  },
  {
    label: "Binance 官方产品/生态题目",
    pattern: /\b(?:binance\s+alpha|binance\s+wallet|bnb\s+chain|bnbchain|launchpool|megadrop)\b/iu
  },
  {
    label: "BNB 对比题目",
    pattern: /\b(?:vs\.?\s+bnb|bnb\s+vs\.?)\b/iu
  },
  {
    label: "CZ/Yi He 是题目核心人物",
    pattern: /\b(?:cz|changpeng|yi\s*he|he\s*yi)\b/iu
  },
  {
    label: "中文币安主题",
    pattern: /币安/u
  }
];

const WORLD_CUP_TEAM_ALIASES = [
  { zh: "阿尔巴尼亚", code: "ALB", flag: "🇦🇱", aliases: ["albania", "alb"] },
  { zh: "阿尔及利亚", code: "ALG", flag: "🇩🇿", aliases: ["algeria", "alg"] },
  { zh: "安哥拉", code: "ANG", flag: "🇦🇴", aliases: ["angola", "ang"] },
  { zh: "阿根廷", code: "ARG", flag: "🇦🇷", aliases: ["argentina", "arg"] },
  { zh: "澳大利亚", code: "AUS", flag: "🇦🇺", aliases: ["australia", "aus"] },
  { zh: "奥地利", code: "AUT", flag: "🇦🇹", aliases: ["austria", "aut"] },
  { zh: "比利时", code: "BEL", flag: "🇧🇪", aliases: ["belgium", "bel"] },
  { zh: "玻利维亚", code: "BOL", flag: "🇧🇴", aliases: ["bolivia", "bol"] },
  { zh: "波黑", code: "BIH", flag: "🇧🇦", aliases: ["bosnia and herzegovina", "bosnia", "bih"] },
  { zh: "巴西", code: "BRA", flag: "🇧🇷", aliases: ["brazil", "bra"] },
  { zh: "保加利亚", code: "BUL", flag: "🇧🇬", aliases: ["bulgaria", "bul"] },
  { zh: "布基纳法索", code: "BFA", flag: "🇧🇫", aliases: ["burkina faso", "bfa"] },
  { zh: "喀麦隆", code: "CMR", flag: "🇨🇲", aliases: ["cameroon", "cmr"] },
  { zh: "加拿大", code: "CAN", flag: "🇨🇦", aliases: ["canada", "can"] },
  { zh: "佛得角", code: "CPV", flag: "🇨🇻", aliases: ["cape verde", "cabo verde", "cpv"] },
  { zh: "智利", code: "CHI", flag: "🇨🇱", aliases: ["chile", "chi"] },
  { zh: "中国", code: "CHN", flag: "🇨🇳", aliases: ["china", "china pr", "chn", "pr china"] },
  { zh: "哥伦比亚", code: "COL", flag: "🇨🇴", aliases: ["colombia", "col"] },
  { zh: "哥斯达黎加", code: "CRC", flag: "🇨🇷", aliases: ["costa rica", "crc"] },
  { zh: "科特迪瓦", code: "CIV", flag: "🇨🇮", aliases: ["cote d ivoire", "côte d'ivoire", "côte d’ivoire", "ivory coast", "civ"] },
  { zh: "克罗地亚", code: "CRO", flag: "🇭🇷", aliases: ["croatia", "cro"] },
  { zh: "库拉索", code: "CUW", flag: "🇨🇼", aliases: ["curacao", "curaçao", "cuw"] },
  { zh: "捷克", code: "CZE", flag: "🇨🇿", aliases: ["czechia", "czech republic", "cze"] },
  { zh: "丹麦", code: "DEN", flag: "🇩🇰", aliases: ["denmark", "den"] },
  { zh: "刚果（金）", code: "COD", flag: "🇨🇩", aliases: ["dr congo", "congo dr", "congo democratic republic", "democratic republic of the congo", "cod"] },
  { zh: "厄瓜多尔", code: "ECU", flag: "🇪🇨", aliases: ["ecuador", "ecu"] },
  { zh: "埃及", code: "EGY", flag: "🇪🇬", aliases: ["egypt", "egy"] },
  { zh: "英格兰", code: "ENG", flag: "🏴", aliases: ["england", "eng"] },
  { zh: "法国", code: "FRA", flag: "🇫🇷", aliases: ["france", "fra"] },
  { zh: "格鲁吉亚", code: "GEO", flag: "🇬🇪", aliases: ["georgia", "geo"] },
  { zh: "德国", code: "GER", flag: "🇩🇪", aliases: ["germany", "deutschland", "ger"] },
  { zh: "加纳", code: "GHA", flag: "🇬🇭", aliases: ["ghana", "gha"] },
  { zh: "希腊", code: "GRE", flag: "🇬🇷", aliases: ["greece", "gre"] },
  { zh: "几内亚", code: "GUI", flag: "🇬🇳", aliases: ["guinea", "gui"] },
  { zh: "海地", code: "HAI", flag: "🇭🇹", aliases: ["haiti", "hai"] },
  { zh: "洪都拉斯", code: "HON", flag: "🇭🇳", aliases: ["honduras", "hon"] },
  { zh: "匈牙利", code: "HUN", flag: "🇭🇺", aliases: ["hungary", "hun"] },
  { zh: "冰岛", code: "ISL", flag: "🇮🇸", aliases: ["iceland", "isl"] },
  { zh: "伊朗", code: "IRN", flag: "🇮🇷", aliases: ["iran", "iran ir", "irn"] },
  { zh: "伊拉克", code: "IRQ", flag: "🇮🇶", aliases: ["iraq", "irq"] },
  { zh: "爱尔兰", code: "IRL", flag: "🇮🇪", aliases: ["ireland", "republic of ireland", "irl"] },
  { zh: "以色列", code: "ISR", flag: "🇮🇱", aliases: ["israel", "isr"] },
  { zh: "意大利", code: "ITA", flag: "🇮🇹", aliases: ["italy", "ita"] },
  { zh: "牙买加", code: "JAM", flag: "🇯🇲", aliases: ["jamaica", "jam"] },
  { zh: "日本", code: "JPN", flag: "🇯🇵", aliases: ["japan", "jpn"] },
  { zh: "约旦", code: "JOR", flag: "🇯🇴", aliases: ["jordan", "jor"] },
  { zh: "科索沃", code: "KOS", flag: "🇽🇰", aliases: ["kosovo", "kos"] },
  { zh: "韩国", code: "KOR", flag: "🇰🇷", aliases: ["korea republic", "south korea", "republic of korea", "korea", "kor"] },
  { zh: "马里", code: "MLI", flag: "🇲🇱", aliases: ["mali", "mli"] },
  { zh: "墨西哥", code: "MEX", flag: "🇲🇽", aliases: ["mexico", "mex"] },
  { zh: "摩洛哥", code: "MAR", flag: "🇲🇦", aliases: ["morocco", "mar"] },
  { zh: "荷兰", code: "NED", flag: "🇳🇱", aliases: ["netherlands", "holland", "ned"] },
  { zh: "新西兰", code: "NZL", flag: "🇳🇿", aliases: ["new zealand", "nzl"] },
  { zh: "尼日利亚", code: "NGA", flag: "🇳🇬", aliases: ["nigeria", "nga"] },
  { zh: "北马其顿", code: "MKD", flag: "🇲🇰", aliases: ["north macedonia", "macedonia", "mkd"] },
  { zh: "北爱尔兰", code: "NIR", flag: "🏴", aliases: ["northern ireland", "nir"] },
  { zh: "挪威", code: "NOR", flag: "🇳🇴", aliases: ["norway", "nor"] },
  { zh: "巴拿马", code: "PAN", flag: "🇵🇦", aliases: ["panama", "pan"] },
  { zh: "巴拉圭", code: "PAR", flag: "🇵🇾", aliases: ["paraguay", "par"] },
  { zh: "秘鲁", code: "PER", flag: "🇵🇪", aliases: ["peru", "per"] },
  { zh: "波兰", code: "POL", flag: "🇵🇱", aliases: ["poland", "pol"] },
  { zh: "葡萄牙", code: "POR", flag: "🇵🇹", aliases: ["portugal", "por"] },
  { zh: "卡塔尔", code: "QAT", flag: "🇶🇦", aliases: ["qatar", "qat"] },
  { zh: "罗马尼亚", code: "ROU", flag: "🇷🇴", aliases: ["romania", "rou"] },
  { zh: "沙特阿拉伯", code: "KSA", flag: "🇸🇦", aliases: ["saudi arabia", "saudi", "ksa"] },
  { zh: "苏格兰", code: "SCO", flag: "🏴", aliases: ["scotland", "sco"] },
  { zh: "塞内加尔", code: "SEN", flag: "🇸🇳", aliases: ["senegal", "sen"] },
  { zh: "塞尔维亚", code: "SRB", flag: "🇷🇸", aliases: ["serbia", "srb"] },
  { zh: "斯洛伐克", code: "SVK", flag: "🇸🇰", aliases: ["slovakia", "svk"] },
  { zh: "斯洛文尼亚", code: "SVN", flag: "🇸🇮", aliases: ["slovenia", "svn"] },
  { zh: "南非", code: "RSA", flag: "🇿🇦", aliases: ["south africa", "rsa"] },
  { zh: "西班牙", code: "ESP", flag: "🇪🇸", aliases: ["spain", "esp"] },
  { zh: "瑞典", code: "SWE", flag: "🇸🇪", aliases: ["sweden", "swe"] },
  { zh: "瑞士", code: "SUI", flag: "🇨🇭", aliases: ["switzerland", "sui"] },
  { zh: "突尼斯", code: "TUN", flag: "🇹🇳", aliases: ["tunisia", "tun"] },
  { zh: "土耳其", code: "TUR", flag: "🇹🇷", aliases: ["turkey", "turkiye", "türkiye", "tur"] },
  { zh: "乌克兰", code: "UKR", flag: "🇺🇦", aliases: ["ukraine", "ukr"] },
  { zh: "阿联酋", code: "UAE", flag: "🇦🇪", aliases: ["united arab emirates", "uae"] },
  { zh: "美国", code: "USA", flag: "🇺🇸", aliases: ["united states", "united states of america", "usa", "usmnt"] },
  { zh: "乌拉圭", code: "URU", flag: "🇺🇾", aliases: ["uruguay", "uru"] },
  { zh: "乌兹别克斯坦", code: "UZB", flag: "🇺🇿", aliases: ["uzbekistan", "uzb"] },
  { zh: "委内瑞拉", code: "VEN", flag: "🇻🇪", aliases: ["venezuela", "ven"] },
  { zh: "威尔士", code: "WAL", flag: "🏴", aliases: ["wales", "wal"] }
];

const WORLD_CUP_TEAM_BY_ALIAS = new Map();
for (const team of WORLD_CUP_TEAM_ALIASES) {
  for (const alias of [team.zh, team.code, ...team.aliases]) {
    WORLD_CUP_TEAM_BY_ALIAS.set(normalizeTeamAlias(alias), team);
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(JSON.stringify({ level: "event-intel-fatal", message: errorMessage(error) }));
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }

  const cfg = readConfig();
  const opts = buildEventIntelOptions(args, { outputDir: args.outputDir });
  let market = null;
  if (args.market) {
    try {
      market = await fetchMarket(cfg, args.market);
    } catch (error) {
      market = {
        address: args.market,
        question: args.question ?? "",
        startDate: args.startDate ?? null,
        createdAt: args.createdAt ?? null,
        status: null,
        fetchError: errorMessage(error)
      };
    }
  } else {
    market = {
      address: args.address ?? null,
      question: args.question ?? "",
      startDate: args.startDate ?? null,
      createdAt: args.createdAt ?? null,
      status: args.status ?? null
    };
  }

  const report = await runEventIntel({ cfg, market, source: args.source ?? "manual", opts });
  console.log(JSON.stringify({
    level: "event-intel-complete",
    market: report.market,
    question: report.question,
    eventKind: report.classification.eventKind,
    binanceRelation: report.binanceRelation.level,
    priority: report.priority,
    mdFile: report.files.mdFile,
    jsonFile: report.files.jsonFile
  }));
}

export function buildEventIntelOptions(args = {}, { outputDir = "output" } = {}) {
  const baseOutputDir = String(args.intelOutputDir ?? process.env.EVENT_INTEL_OUTPUT_DIR ?? path.join(String(outputDir), "event-intel"));
  const maxResults = positiveInteger(args.intelMaxResults ?? process.env.EVENT_INTEL_MAX_RESULTS, DEFAULT_MAX_RESULTS);
  const createdAtOpenThresholdMinutes = positiveInteger(
    args.intelCreatedAtOpenThresholdMinutes ?? process.env.EVENT_INTEL_CREATED_AT_OPEN_THRESHOLD_MINUTES,
    DEFAULT_CREATED_AT_OPEN_THRESHOLD_MINUTES
  );
  const bot2DisplayFilterRulesRaw = args.intelBot2DisplayFilterRules ?? process.env.EVENT_INTEL_BOT2_DISPLAY_FILTER_RULES;
  const bot3DisplayFilterRulesRaw = args.intelBot3DisplayFilterRules ?? process.env.EVENT_INTEL_BOT3_DISPLAY_FILTER_RULES;
  const bot5DisplayFilterRulesRaw = args.intelBot5DisplayFilterRules ?? process.env.EVENT_INTEL_BOT5_DISPLAY_FILTER_RULES;
  return {
    enabled: boolValue(args.intelEnabled ?? process.env.EVENT_INTEL_ENABLED, true),
    skipFixed: boolValue(args.intelSkipFixed ?? process.env.EVENT_INTEL_SKIP_FIXED, true),
    skipPrice: boolValue(args.intelSkipPrice ?? process.env.EVENT_INTEL_SKIP_PRICE, true),
    outputDir: baseOutputDir,
    intelFile: String(args.intelFile ?? process.env.EVENT_INTEL_FILE ?? path.join(String(outputDir), "event-intel.jsonl")),
    seenFile: String(
      args.intelSeenFile ??
      process.env.EVENT_INTEL_SEEN_FILE ??
      path.join(String(outputDir), "event-intel-seen.json")
    ),
    templateRegex: new RegExp(String(args.intelTemplateRegex ?? process.env.EVENT_INTEL_TEMPLATE_REGEX ?? DEFAULT_TEMPLATE_REGEX), "i"),
    createdAtOpenThresholdMs: positiveInteger(
      args.intelCreatedAtOpenThresholdMs ?? process.env.EVENT_INTEL_CREATED_AT_OPEN_THRESHOLD_MS,
      createdAtOpenThresholdMinutes * 60_000
    ),
    maxResults,
    timeoutMs: positiveInteger(args.intelTimeoutMs ?? process.env.EVENT_INTEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    searchWindowHours: positiveInteger(
      args.intelSearchWindowHours ?? process.env.EVENT_INTEL_SEARCH_WINDOW_HOURS,
      DEFAULT_SEARCH_WINDOW_HOURS
    ),
    searchProvider: String(args.intelSearchProvider ?? process.env.EVENT_INTEL_SEARCH_PROVIDER ?? "auto").toLowerCase(),
    braveSearchApiKey: String(args.braveSearchApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? ""),
    serpapiApiKey: String(args.serpapiApiKey ?? process.env.SERPAPI_API_KEY ?? ""),
    webSearchUrlTemplate: String(args.webSearchUrlTemplate ?? process.env.EVENT_INTEL_WEB_SEARCH_URL_TEMPLATE ?? ""),
    webSearchHeaders: parseHeaderJson(args.webSearchHeaders ?? process.env.EVENT_INTEL_WEB_SEARCH_HEADERS_JSON),
    xProvider: String(args.intelXProvider ?? process.env.EVENT_INTEL_X_PROVIDER ?? "auto").toLowerCase(),
    twitterapiIoKey: String(
      args.twitterapiIoKey ??
      process.env.EVENT_INTEL_TWITTERAPI_IO_KEY ??
      process.env.TWITTERAPI_IO_KEY ??
      ""
    ),
    twitterapiIoBaseUrl: String(
      args.twitterapiIoBaseUrl ??
      process.env.EVENT_INTEL_TWITTERAPI_IO_BASE_URL ??
      DEFAULT_TWITTERAPI_IO_BASE_URL
    ),
    xQueryType: String(args.xQueryType ?? process.env.EVENT_INTEL_X_QUERY_TYPE ?? DEFAULT_X_QUERY_TYPE),
    xBearerToken: String(
      args.xBearerToken ??
      process.env.EVENT_INTEL_X_BEARER_TOKEN ??
      process.env.TWITTER_BEARER_TOKEN ??
      process.env.X_BEARER_TOKEN ??
      ""
    ),
    xSearchUrlTemplate: String(args.xSearchUrlTemplate ?? process.env.EVENT_INTEL_X_SEARCH_URL_TEMPLATE ?? ""),
    xSearchHeaders: parseHeaderJson(args.xSearchHeaders ?? process.env.EVENT_INTEL_X_HEADERS_JSON),
    notifyNonTemplate: boolValue(args.intelNotifyNonTemplate ?? process.env.EVENT_INTEL_NOTIFY_NON_TEMPLATE, true),
    notifyPriceEvents: boolValue(args.intelNotifyPriceEvents ?? process.env.EVENT_INTEL_NOTIFY_PRICE_EVENTS, false),
    notifyStrong: boolValue(args.intelNotifyStrong ?? process.env.EVENT_INTEL_NOTIFY_STRONG, false),
    displayFilterRules: normalizeEventDisplayFilterRules(
      args.displayFilterRules ?? process.env.EVENT_DISPLAY_FILTER_RULES,
      { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }
    ),
    notifyWebhook: String(
      args.intelNotifyWebhook ??
      process.env.EVENT_INTEL_FEISHU_WEBHOOK ??
      process.env.BOT1_FEISHU_WEBHOOK ??
      ""
    ),
    bot2NotifyWebhook: String(
      args.intelBot2NotifyWebhook ??
      process.env.EVENT_INTEL_BOT2_FEISHU_WEBHOOK ??
      process.env.BOT2_FEISHU_WEBHOOK ??
      ""
    ),
    bot2RuntimeConfigFile: String(
      args.intelBot2RuntimeConfigFile ??
      process.env.EVENT_INTEL_BOT2_RUNTIME_CONFIG_FILE ??
      ""
    ),
    bot2DisplayFilterRules: bot2DisplayFilterRulesRaw === undefined
      ? null
      : normalizeEventDisplayFilterRules(bot2DisplayFilterRulesRaw, { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }),
    bot2NotifyBotName: String(args.intelBot2NotifyBotName ?? process.env.EVENT_INTEL_BOT2_NOTIFY_BOT_NAME ?? "Bot2"),
    bot3NotifyWebhook: String(
      args.intelBot3NotifyWebhook ??
      process.env.EVENT_INTEL_BOT3_FEISHU_WEBHOOK ??
      process.env.BOT3_FEISHU_WEBHOOK ??
      ""
    ),
    bot3RuntimeConfigFile: String(
      args.intelBot3RuntimeConfigFile ??
      process.env.EVENT_INTEL_BOT3_RUNTIME_CONFIG_FILE ??
      ""
    ),
    bot3DisplayFilterRules: bot3DisplayFilterRulesRaw === undefined
      ? null
      : normalizeEventDisplayFilterRules(bot3DisplayFilterRulesRaw, { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }),
    bot3NotifyBotName: String(args.intelBot3NotifyBotName ?? process.env.EVENT_INTEL_BOT3_NOTIFY_BOT_NAME ?? "Bot3"),
    bot5NotifyWebhook: String(
      args.intelBot5NotifyWebhook ??
      process.env.EVENT_INTEL_BOT5_FEISHU_WEBHOOK ??
      process.env.BOT5_FEISHU_WEBHOOK ??
      ""
    ),
    bot5RuntimeConfigFile: String(
      args.intelBot5RuntimeConfigFile ??
      process.env.EVENT_INTEL_BOT5_RUNTIME_CONFIG_FILE ??
      ""
    ),
    bot5DisplayFilterRules: bot5DisplayFilterRulesRaw === undefined
      ? null
      : normalizeEventDisplayFilterRules(bot5DisplayFilterRulesRaw, { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }),
    bot5NotifyBotName: String(args.intelBot5NotifyBotName ?? process.env.EVENT_INTEL_BOT5_NOTIFY_BOT_NAME ?? "Bot5"),
    notifyBotName: String(args.intelNotifyBotName ?? process.env.EVENT_INTEL_NOTIFY_BOT_NAME ?? "42space"),
    notifySeenFile: String(
      args.intelNotifySeenFile ??
      process.env.EVENT_INTEL_NOTIFY_SEEN_FILE ??
      path.join(String(outputDir), "event-intel-notify-seen.json")
    ),
    maxTextChars: positiveInteger(args.intelMaxTextChars ?? process.env.EVENT_INTEL_MAX_TEXT_CHARS, 6000)
  };
}

export async function runEventIntel({ cfg, market, source = "unknown", discovery = {}, opts = buildEventIntelOptions() }) {
  const classification = classifyEventIntelMarket(market, opts);
  const query = buildIntelQuery(market);
  const skipHeavyReason = eventIntelSkipHeavyReason(classification, opts, market);
  const webSearch = skipHeavyReason
    ? skippedSource(skipHeavyReason)
    : await safeSource(() => searchWeb(query, opts), "web-search");
  const xSearch = skipHeavyReason
    ? skippedSource(skipHeavyReason)
    : await safeSource(() => searchX(buildXQuery(market), opts), "x-search");

  const binanceRelation = evaluateBinanceRelation({ market, webSearch, xSearch });
  const socialHeat = evaluateSocialHeat({ xSearch });
  const priority = classifyPriority({ classification, binanceRelation, socialHeat });
  const outcomes = normalizeOutcomeSummaries(market?.outcomes);
  const sportsMatch = buildSportsMatchSummary(market, outcomes);
  const report = {
    level: "event-intel-report",
    mode: "event:intel",
    readOnly: true,
    market: market?.address ?? null,
    question: marketQuestion(market),
    status: market?.status ?? null,
    startDate: market?.startDate ?? null,
    endDate: market?.endDate ?? null,
    createdAt: market?.createdAt ?? null,
    categories: Array.isArray(market?.categories) ? market.categories : [],
    subcategories: Array.isArray(market?.subcategories) ? market.subcategories : [],
    topics: Array.isArray(market?.topics) ? market.topics : [],
    tags: Array.isArray(market?.tags) ? market.tags : [],
    outcomes,
    sportsMatch,
    source,
    discovery,
    classification,
    explanation: buildExplanation({ market, webSearch }),
    query,
    xQuery: buildXQuery(market),
    webSearch,
    xSearch,
    binanceRelation,
    socialHeat,
    priority,
    files: {},
    at: new Date().toISOString()
  };

  report.files = buildIntelReportFiles(report, opts);
  writeIntelReport({ report, opts });
  await maybeNotifyEventIntel(cfg, report, opts);
  return report;
}

export function classifyEventIntelMarket(market, opts = buildEventIntelOptions()) {
  const question = marketQuestion(market);
  const startDate = market?.startDate ? new Date(market.startDate) : null;
  const createdDate = market?.createdAt ? new Date(market.createdAt) : null;
  const startMs = startDate?.getTime();
  const createdMs = createdDate?.getTime();
  const hasStart = Number.isFinite(startMs);
  const utcHour = hasStart ? startDate.getUTCHours() : null;
  const utcMinute = hasStart ? startDate.getUTCMinutes() : null;
  const knownTemplate = Boolean(question && opts.templateRegex?.test(question));
  const fixedTime = utcHour === 0 && utcMinute === 0;
  const thresholdMs = positiveInteger(opts.createdAtOpenThresholdMs, DEFAULT_CREATED_AT_OPEN_THRESHOLD_MINUTES * 60_000);
  const createdAtOpen = Number.isFinite(createdMs) && Number.isFinite(startMs) && Math.abs(startMs - createdMs) <= thresholdMs;
  const priceEvent = isEventIntelPriceMarket(market);
  const fixedTemplate = Boolean(knownTemplate && !createdAtOpen);
  const eventKind = fixedTemplate ? "fixed-template" : priceEvent ? "price-event" : "non-template";
  return {
    eventKind,
    fixedTemplate,
    priceEvent,
    knownTemplate,
    fixedTime,
    createdAtOpen,
    createdAtOpenThresholdMs: thresholdMs,
    templateName: knownTemplate ? templateName(question) : null,
    reason: fixedTemplate
      ? "known recurring template"
      : priceEvent
        ? "price market"
      : knownTemplate && createdAtOpen
        ? "template-like title but created at open"
        : knownTemplate
          ? "template-like title without close-open creation"
          : "non-template or incomplete title"
  };
}

async function searchWeb(query, opts) {
  const provider = resolveWebProvider(opts);
  if (!provider) return notConfiguredSource("web-search");
  if (provider === "brave") return searchBrave(query, opts);
  if (provider === "serpapi") return searchSerpapi(query, opts);
  if (provider === "custom") return searchCustomJson({
    provider: "custom",
    urlTemplate: opts.webSearchUrlTemplate,
    headers: opts.webSearchHeaders,
    query,
    maxResults: opts.maxResults,
    timeoutMs: opts.timeoutMs,
    sourceType: "web-search"
  });
  return notConfiguredSource("web-search");
}

async function searchX(query, opts) {
  const provider = resolveXProvider(opts);
  if (!provider) return notConfiguredSource("x-search");
  if (provider === "twitterapi-io") return searchTwitterApiIo(query, opts);
  if (provider === "x-official") return searchXOfficial(query, opts);
  if (provider === "custom") return searchCustomJson({
    provider: "custom",
    urlTemplate: opts.xSearchUrlTemplate,
    headers: opts.xSearchHeaders,
    query,
    maxResults: opts.maxResults,
    timeoutMs: opts.timeoutMs,
    sourceType: "x-search"
  });
  return notConfiguredSource("x-search");
}

function resolveWebProvider(opts) {
  if (opts.searchProvider === "none" || opts.searchProvider === "disabled") return null;
  if (opts.searchProvider === "brave" && opts.braveSearchApiKey) return "brave";
  if (opts.searchProvider === "serpapi" && opts.serpapiApiKey) return "serpapi";
  if (opts.searchProvider === "custom" && opts.webSearchUrlTemplate) return "custom";
  if (opts.searchProvider === "auto") {
    if (opts.braveSearchApiKey) return "brave";
    if (opts.serpapiApiKey) return "serpapi";
    if (opts.webSearchUrlTemplate) return "custom";
  }
  return null;
}

function resolveXProvider(opts) {
  if (opts.xProvider === "none" || opts.xProvider === "disabled") return null;
  if (["twitterapi-io", "twitterapi", "twitterapi.io"].includes(opts.xProvider) && opts.twitterapiIoKey) {
    return "twitterapi-io";
  }
  if (opts.xProvider === "official" && opts.xBearerToken) return "x-official";
  if (opts.xProvider === "custom" && opts.xSearchUrlTemplate) return "custom";
  if (opts.xProvider === "auto") {
    if (opts.twitterapiIoKey) return "twitterapi-io";
    if (opts.xSearchUrlTemplate) return "custom";
    if (opts.xBearerToken) return "x-official";
  }
  return null;
}

async function searchBrave(query, opts) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(opts.maxResults));
  const json = await fetchJson(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": opts.braveSearchApiKey
    },
    timeoutMs: opts.timeoutMs,
    label: "Brave search"
  });
  const results = (json.web?.results ?? []).slice(0, opts.maxResults).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    snippet: item.description ?? "",
    source: hostname(item.url)
  }));
  return configuredSource({ type: "web-search", provider: "brave", query, results });
}

async function searchSerpapi(query, opts) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(opts.maxResults));
  url.searchParams.set("api_key", opts.serpapiApiKey);
  const json = await fetchJson(url, {
    headers: { accept: "application/json" },
    timeoutMs: opts.timeoutMs,
    label: "SerpAPI search"
  });
  const results = (json.organic_results ?? []).slice(0, opts.maxResults).map((item) => ({
    title: item.title ?? "",
    url: item.link ?? "",
    snippet: item.snippet ?? "",
    source: hostname(item.link)
  }));
  return configuredSource({ type: "web-search", provider: "serpapi", query, results });
}

async function searchXOfficial(query, opts) {
  const url = new URL("https://api.twitter.com/2/tweets/search/recent");
  url.searchParams.set("query", query);
  url.searchParams.set("max_results", String(Math.max(10, Math.min(100, opts.maxResults * 2))));
  url.searchParams.set("tweet.fields", "created_at,public_metrics,author_id,lang");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name,verified");
  const json = await fetchJson(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${opts.xBearerToken}`
    },
    timeoutMs: opts.timeoutMs,
    label: "X recent search"
  });
  const users = new Map((json.includes?.users ?? []).map((user) => [String(user.id), user]));
  const results = (json.data ?? []).slice(0, opts.maxResults).map((tweet) => {
    const user = users.get(String(tweet.author_id)) ?? {};
    return {
      title: `@${user.username ?? tweet.author_id}`,
      url: tweet.id ? `https://x.com/${user.username ?? "i"}/status/${tweet.id}` : "",
      snippet: tweet.text ?? "",
      authorUsername: user.username ?? null,
      authorName: user.name ?? null,
      verified: Boolean(user.verified),
      metrics: tweet.public_metrics ?? {},
      createdAt: tweet.created_at ?? null
    };
  });
  return configuredSource({ type: "x-search", provider: "x-official", query, results });
}

async function searchTwitterApiIo(query, opts) {
  const url = new URL("/twitter/tweet/advanced_search", opts.twitterapiIoBaseUrl);
  const windowedQuery = withSinceTime(query, opts.searchWindowHours);
  url.searchParams.set("query", windowedQuery);
  url.searchParams.set("queryType", opts.xQueryType || DEFAULT_X_QUERY_TYPE);
  const json = await fetchJson(url, {
    headers: {
      accept: "application/json",
      "X-API-Key": opts.twitterapiIoKey
    },
    timeoutMs: opts.timeoutMs,
    label: "TwitterAPI.io search"
  });
  const results = extractTwitterApiIoResults(json).slice(0, opts.maxResults);
  return configuredSource({ type: "x-search", provider: "twitterapi-io", query: windowedQuery, results });
}

async function searchCustomJson({ provider, urlTemplate, headers, query, maxResults, timeoutMs, sourceType }) {
  const url = fillTemplate(urlTemplate, { query, maxResults });
  const json = await fetchJson(url, {
    headers: { accept: "application/json", ...headers },
    timeoutMs,
    label: `${sourceType} custom`
  });
  const results = extractGenericResults(json).slice(0, maxResults);
  return configuredSource({ type: sourceType, provider, query, results });
}

async function fetchJson(url, { headers, timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${label} ${response.status}: ${body.slice(0, 300)}`);
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(`${label} invalid JSON: ${error.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function safeSource(fn, type) {
  try {
    return await fn();
  } catch (error) {
    return {
      type,
      configured: true,
      ok: false,
      provider: null,
      query: null,
      results: [],
      resultCount: 0,
      error: errorMessage(error)
    };
  }
}

function configuredSource({ type, provider, query, results }) {
  return {
    type,
    configured: true,
    ok: true,
    provider,
    query,
    results,
    resultCount: results.length,
    error: null
  };
}

function notConfiguredSource(type) {
  return {
    type,
    configured: false,
    ok: false,
    provider: null,
    query: null,
    results: [],
    resultCount: 0,
    error: "provider-not-configured"
  };
}

function skippedSource(reason) {
  return {
    type: "skipped",
    configured: false,
    ok: false,
    provider: null,
    query: null,
    results: [],
    resultCount: 0,
    error: reason
  };
}

export function evaluateLocalBinanceRelation(market) {
  const evidence = [];
  let score = 0;
  let official = false;
  const strongTopicHits = matchStrongBinanceTopic(market);
  if (strongTopicHits.length) {
    score += 8;
    evidence.push(`42 事件核心主题强相关：${strongTopicHits.join("、")}`);
  }
  const marketText = marketContextText(market);
  const marketHits = matchBinanceTerms(marketText);
  if (marketHits.length) {
    score += marketHits.length * 2;
    evidence.push(`42 事件信息命中：${marketHits.join("、")}`);
  }
  for (const url of extractUrls(marketText)) {
    const binanceUrl = classifyBinanceUrl(url);
    if (binanceUrl.strong) {
      score += 6;
      official = true;
      evidence.push(`42 事件引用 Binance 强相关官方来源：${binanceUrl.host}`);
    } else if (binanceUrl.binance) {
      score += 1;
      evidence.push(`42 事件引用 Binance 数据源：${binanceUrl.host}`);
    }
  }

  let level = "none";
  if (official || strongTopicHits.length > 0 || score >= 8) level = "strong";
  else if (score >= 4) level = "medium";
  else if (score > 0) level = "weak";

  return {
    level,
    score,
    official,
    strongTopic: strongTopicHits.length > 0,
    evidence: unique(evidence).slice(0, 8)
  };
}

function evaluateBinanceRelation({ market, webSearch, xSearch }) {
  const localRelation = evaluateLocalBinanceRelation(market);
  const evidence = [...localRelation.evidence];
  let score = localRelation.score;
  let official = localRelation.official;
  const strongTopic = localRelation.strongTopic;

  for (const result of [...(webSearch.results ?? []), ...(xSearch.results ?? [])]) {
    const text = [result.title, result.snippet, result.url, result.authorUsername, result.authorName]
      .filter(Boolean)
      .join(" ");
    const hits = matchBinanceTerms(text);
    if (hits.length) {
      score += hits.length;
      evidence.push(`结果命中：${trimText(result.title || result.authorUsername || result.url || "搜索结果", 80)} -> ${hits.join("、")}`);
    }
    const host = hostname(result.url);
    if (BINANCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      score += 6;
      official = true;
      evidence.push(`官方域名：${host}`);
    }
    const username = String(result.authorUsername ?? "").replace(/^@/u, "").toLowerCase();
    if (BINANCE_OFFICIAL_USERNAMES.has(username)) {
      score += 8;
      official = true;
      evidence.push(`官方/核心账号：@${username}`);
    }
  }

  const sourcesConfigured = Boolean(webSearch.configured || xSearch.configured);
  let level = "none";
  if (!sourcesConfigured && score === 0) level = "unknown";
  else if (official || strongTopic || score >= 8) level = "strong";
  else if (score >= 4) level = "medium";
  else if (score > 0) level = "weak";

  if (!evidence.length) {
    evidence.push(sourcesConfigured ? "未发现 Binance 相关证据" : "搜索/X provider 未配置，无法判断外部关联");
  }

  return {
    level,
    score,
    official,
    strongTopic,
    evidence: unique(evidence).slice(0, 8)
  };
}

function evaluateSocialHeat({ xSearch }) {
  if (!xSearch.configured) {
    return {
      level: "unknown",
      score: 0,
      resultCount: 0,
      evidence: ["X/Twitter provider 未配置，无法判断推文热度"]
    };
  }
  if (!xSearch.ok) {
    return {
      level: "unknown",
      score: 0,
      resultCount: 0,
      evidence: [`X/Twitter 查询失败：${xSearch.error}`]
    };
  }

  const results = xSearch.results ?? [];
  let score = results.length;
  const evidence = [];
  for (const result of results) {
    const metrics = normalizeMetrics(result.metrics);
    const engagement = metricValue(metrics.likeCount) + metricValue(metrics.retweetCount) * 2 + metricValue(metrics.replyCount) + metricValue(metrics.quoteCount) * 2;
    const views = metricValue(metrics.viewCount);
    if (engagement >= 1000 || views >= 100_000) score += 8;
    else if (engagement >= 100 || views >= 10_000) score += 4;
    else if (engagement >= 10 || views >= 1_000) score += 2;
    const username = String(result.authorUsername ?? "").replace(/^@/u, "").toLowerCase();
    if (BINANCE_OFFICIAL_USERNAMES.has(username)) score += 10;
  }

  const top = [...results].sort((a, b) => engagementScore(b) - engagementScore(a))[0];
  if (results.length) evidence.push(`返回 ${results.length} 条相关推文`);
  if (top) {
    const label = top.authorUsername ? `@${top.authorUsername}` : (top.title || "推文");
    evidence.push(`最高热度线索：${label} ${formatMetrics(top.metrics)}`);
  }

  let level = "none";
  if (score >= 12) level = "hot";
  else if (score >= 5) level = "warm";
  else if (score > 0) level = "low";
  if (!evidence.length) evidence.push("未返回相关推文");

  return {
    level,
    score,
    resultCount: results.length,
    evidence
  };
}

function classifyPriority({ classification, binanceRelation, socialHeat }) {
  if (classification.fixedTemplate) return "archive";
  if (classification.priceEvent) return "archive";
  if (binanceRelation.level === "strong") return "focus";
  if (socialHeat?.level === "hot" && ["medium", "weak"].includes(binanceRelation.level)) return "focus";
  if (binanceRelation.level === "medium") return "watch";
  if (binanceRelation.level === "weak") return "watch-light";
  if (binanceRelation.level === "unknown") return "needs-provider";
  return "archive";
}

function buildExplanation({ market, webSearch }) {
  const question = marketQuestion(market);
  const base = question ? `这个事件在判断：${question}` : "这个事件题目不完整，需要等待 REST 或官网补全。";
  const first = webSearch.results?.find((result) => result.snippet || result.title);
  if (!first) return base;
  return `${base} 搜索线索：${trimText(first.title || first.snippet, 90)}${first.snippet ? `；${trimText(first.snippet, 140)}` : ""}`;
}

function buildIntelReportFiles(report, opts) {
  const base = path.join(opts.outputDir, intelFileStem(report));
  const jsonFile = `${base}.json`;
  const mdFile = `${base}.md`;
  return { jsonFile, mdFile, intelFile: opts.intelFile };
}

function writeIntelReport({ report, opts }) {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  fs.mkdirSync(path.dirname(opts.intelFile), { recursive: true });
  fs.writeFileSync(report.files.jsonFile, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(report.files.mdFile, renderMarkdown(report));
  appendJsonl(opts.intelFile, summarizeForJsonl(report));
}

function summarizeForJsonl(report) {
  return {
    level: "event-intel-report",
    market: report.market,
    question: report.question,
    startDate: report.startDate,
    createdAt: report.createdAt,
    source: report.source,
    eventKind: report.classification.eventKind,
    fixedTemplate: report.classification.fixedTemplate,
    createdAtOpen: report.classification.createdAtOpen,
    binanceRelation: report.binanceRelation.level,
    binanceScore: report.binanceRelation.score,
    socialHeat: report.socialHeat.level,
    socialHeatScore: report.socialHeat.score,
    xSearchProvider: report.xSearch.provider,
    xSearchResultCount: report.xSearch.resultCount,
    webSearchProvider: report.webSearch.provider,
    webSearchResultCount: report.webSearch.resultCount,
    sportsMatchup: report.sportsMatch?.matchupLabel ?? null,
    sportsScoreCount: report.sportsMatch?.scores?.length ?? 0,
    priority: report.priority,
    webSearchConfigured: report.webSearch.configured,
    xSearchConfigured: report.xSearch.configured,
    jsonFile: report.files.jsonFile,
    mdFile: report.files.mdFile,
    at: report.at
  };
}

function renderMarkdown(report) {
  const lines = [
    "# 42 新事件情报卡",
    "",
    `- 事件：${report.question || "n/a"}`,
    `- 地址：\`${report.market || "n/a"}\``,
    `- 开盘：${formatBeijingDateTime(report.startDate)}`,
    `- 创建：${formatBeijingDateTime(report.createdAt)}`,
    `- 创建/开盘：${formatCreatedOpenGap(report)}`,
    `- 来源：${report.source || "n/a"}`,
    `- 类型：${eventKindLabel(report.classification)}`,
    `- 优先级：${priorityLabel(report.priority)}`,
    "",
    ...renderSportsMatchMarkdown(report.sportsMatch),
    "## 一句话说明",
    "",
    report.explanation,
    "",
    "## Binance 关系",
    "",
    `- 判断：${relationLabel(report.binanceRelation.level)}，分数 ${report.binanceRelation.score}`,
    ...report.binanceRelation.evidence.map((item) => `- ${item}`),
    "",
    "## 推文热度",
    "",
    `- 判断：${socialHeatLabel(report.socialHeat.level)}，分数 ${report.socialHeat.score}`,
    ...report.socialHeat.evidence.map((item) => `- ${item}`),
    "",
    "## Web 搜索",
    "",
    renderSourceMarkdown(report.webSearch),
    "",
    "## X / Twitter",
    "",
    renderSourceMarkdown(report.xSearch),
    "",
    "## 边界",
    "",
    "- 这是只读情报层，不会触发买入或卖出。",
    "- 搜索/X 未配置或失败时，不影响 premium 探针。"
  ];
  return `${lines.join("\n")}\n`;
}

function renderSourceMarkdown(source) {
  if (!source.configured) return `- 未配置：${source.error}`;
  if (!source.ok) return `- 查询失败：${source.error}`;
  if (!source.results.length) return `- 已查询 ${source.provider}，没有返回结果。`;
  return [
    `- Provider：${source.provider}`,
    `- 查询：${source.query}`,
    "",
    "| 标题/账号 | 摘要 | 热度 | 链接 |",
    "| --- | --- | --- | --- |",
    ...source.results.slice(0, 5).map((result) =>
      `| ${escapeMarkdown(result.title || result.authorUsername || "n/a")} | ${escapeMarkdown(trimText(result.snippet || "", 180))} | ${escapeMarkdown(formatMetrics(result.metrics))} | ${result.url ? `[link](${result.url})` : "n/a"} |`
    )
  ].join("\n");
}

function renderSportsMatchMarkdown(match) {
  if (!match) return [];
  const lines = [
    "## 世界杯对赛",
    "",
    `- 对赛：${match.matchupLabel}`,
    `- 比分方向：${match.scoreDirectionLabel}`
  ];
  if (!match.scores.length) {
    lines.push("- 比分档位：未从 outcome 中读取到。", "");
    return lines;
  }
  lines.push(
    "",
    "| 比分 | 含义 | 原始 outcome |",
    "| --- | --- | --- |",
    ...match.scores.map((score) =>
      `| ${escapeMarkdown(score.scoreLabel)} | ${escapeMarkdown(formatSportsScoreMeaning(score, match))} | ${escapeMarkdown(score.outcomeName)} |`
    ),
    ""
  );
  return lines;
}

async function maybeNotifyEventIntel(cfg, report, opts) {
  if (!cfg?.feishuAlertsEnabled) return;
  const targets = eventIntelNotificationTargets(cfg, report, opts);
  if (!targets.length) return;

  for (const target of targets) {
    const key = eventIntelNotifyKey(report, target.keyScope);
    if (!key || hasEventIntelNotification(opts, key)) continue;
    try {
      await postFeishuInteractiveCard(
        target.webhook,
        formatEventIntelAlertCard(report, { ...opts, notifyBotName: target.botName }, target.reason)
      );
      markEventIntelNotification(opts, key);
    } catch (error) {
      console.error(JSON.stringify({
        level: "warn",
        source: "event-intel-feishu-error",
        market: report.market,
        reason: target.reason,
        target: target.keyScope,
        message: errorMessage(error),
        at: new Date().toISOString()
      }));
    }
  }
}

function eventIntelNotificationTargets(cfg, report, opts) {
  const targets = [];
  const primaryReason = eventIntelNotifyReason(report, opts, cfg);
  const primaryWebhook = opts.notifyWebhook || profileEventIntelWebhook(cfg);
  if (primaryReason && primaryWebhook) {
    targets.push({
      keyScope: "primary",
      reason: primaryReason,
      webhook: primaryWebhook,
      botName: opts.notifyBotName || cfg?.botName || "42space"
    });
  }

  for (const profile of auxiliaryEventIntelProfiles(cfg, opts)) {
    const reason = profile.webhook && !profile.isCurrentProfile
      ? filteredProfileEventIntelNotifyReason(report, opts, profile.filterConfig)
      : null;
    if (reason) {
      targets.push({
        keyScope: profile.keyScope,
        reason,
        webhook: profile.webhook,
        botName: profile.botName
      });
    }
  }
  return targets;
}

function profileEventIntelWebhook(cfg) {
  return isBot1ProfileName(cfg?.botName) || isFilteredNotificationProfile(cfg)
    ? String(cfg?.feishuWebhook ?? "")
    : "";
}

function normalizeProfileRole(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function isBot1ProfileName(botName) {
  const normalized = String(botName ?? "").trim().toLowerCase();
  return normalized === "42space" || normalized.startsWith("bot1");
}

function isBot2ProfileName(botName) {
  const normalized = String(botName ?? "").trim().toLowerCase();
  return normalized === "42space-2" || normalized === "bot2" || normalized.startsWith("bot2");
}

function isBot5ProfileName(botName) {
  const normalized = String(botName ?? "").trim().toLowerCase();
  return normalized === "42space-5" || normalized === "bot5" || normalized.startsWith("bot5") || normalized.includes("bot5");
}

function isBot2LikeProfile(cfgOrBotName) {
  if (cfgOrBotName && typeof cfgOrBotName === "object") {
    return normalizeProfileRole(cfgOrBotName.profileRole) === "bot2_like" ||
      isBot2ProfileName(cfgOrBotName.botName) ||
      isBot5ProfileName(cfgOrBotName.botName);
  }
  return isBot2ProfileName(cfgOrBotName) || isBot5ProfileName(cfgOrBotName);
}

function isBot3ProfileName(botName) {
  const normalized = String(botName ?? "").trim().toLowerCase();
  return normalized === "42space-3" || normalized === "bot3" || normalized.startsWith("bot3");
}

function isFilteredNotificationProfile(cfgOrBotName) {
  if (cfgOrBotName && typeof cfgOrBotName === "object") {
    return isBot2LikeProfile(cfgOrBotName) || isBot3ProfileName(cfgOrBotName.botName);
  }
  return isBot2LikeProfile(cfgOrBotName) || isBot3ProfileName(cfgOrBotName);
}

function auxiliaryEventIntelProfiles(cfg, opts) {
  return [
    {
      keyScope: "bot2-focus",
      webhook: opts.bot2NotifyWebhook,
      botName: opts.bot2NotifyBotName || "Bot2",
      filterConfig: eventDisplayFilterConfig(opts.bot2RuntimeConfigFile, opts.bot2DisplayFilterRules, opts),
      isCurrentProfile: isBot2ProfileName(cfg?.botName)
    },
    {
      keyScope: "bot3-filtered",
      webhook: opts.bot3NotifyWebhook,
      botName: opts.bot3NotifyBotName || "Bot3",
      filterConfig: eventDisplayFilterConfig(opts.bot3RuntimeConfigFile, opts.bot3DisplayFilterRules, opts),
      isCurrentProfile: isBot3ProfileName(cfg?.botName)
    },
    {
      keyScope: "bot5-focus",
      webhook: opts.bot5NotifyWebhook,
      botName: opts.bot5NotifyBotName || "Bot5",
      filterConfig: eventDisplayFilterConfig(opts.bot5RuntimeConfigFile, opts.bot5DisplayFilterRules, opts),
      isCurrentProfile: isBot5ProfileName(cfg?.botName)
    }
  ];
}

function eventDisplayFilterConfig(runtimeConfigFile, displayFilterRules, opts) {
  const runtimeRules = readRuntimeDisplayFilterRules(runtimeConfigFile);
  return {
    eventDisplayFilterRules: displayFilterRules ??
      runtimeRules ??
      opts.displayFilterRules
  };
}

function readRuntimeDisplayFilterRules(file) {
  const pathName = String(file ?? "").trim();
  if (!pathName) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pathName, "utf8"));
    if (!Object.prototype.hasOwnProperty.call(parsed, "eventDisplayFilterRules")) return null;
    return normalizeEventDisplayFilterRules(parsed.eventDisplayFilterRules, { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS });
  } catch {
    return null;
  }
}

function eventIntelNotifyReason(report, opts, cfg = null) {
  const filterDecision = getEventDisplayFilterDecision(report, cfg, opts);
  if (filterDecision.filtered) return null;
  if (isFilteredNotificationProfile(cfg ?? opts.notifyBotName)) {
    return filteredProfileEventIntelNotifyReason(report, opts, cfg);
  }
  if (opts.notifyNonTemplate && isSportsExactScoreMarket(report)) return "sports-exact-score";
  if (!report.classification.createdAtOpen) return null;
  if (opts.notifyNonTemplate) return "unfiltered-event";
  if (opts.notifyStrong && report.binanceRelation.level === "strong") return "strong-binance";
  return null;
}

function filteredProfileEventIntelNotifyReason(report, opts, filterConfig = null) {
  const filterDecision = getEventDisplayFilterDecision(report, filterConfig ?? { eventDisplayFilterRules: opts.displayFilterRules }, opts);
  if (filterDecision.filtered) return null;
  if (opts.notifyNonTemplate && isSportsExactScoreMarket(report)) return "sports-exact-score";
  if (opts.notifyNonTemplate && isSportsPlayerPropMarket(report)) return "sports-player-prop";
  if (opts.notifyNonTemplate && isMemeIntelMarket(report)) return "meme";
  if ((opts.notifyNonTemplate || opts.notifyStrong) && report.binanceRelation.level === "strong") return "strong-binance";
  if (opts.notifyNonTemplate) return "unfiltered-event";
  return null;
}

export function getEventDisplayFilterDecision(market, cfg = {}, opts = buildEventIntelOptions()) {
  const enabledRules = normalizeEventDisplayFilterRules(
    cfg?.eventDisplayFilterRules ?? opts.displayFilterRules,
    { fallback: DEFAULT_EVENT_DISPLAY_FILTER_RULE_IDS }
  );
  for (const ruleId of enabledRules) {
    const match = getEventDisplayRuleMatch(market, ruleId, opts);
    if (match) {
      return {
        filtered: true,
        ...match
      };
    }
  }

  return {
    filtered: false,
    ruleId: "",
    reason: "display-unfiltered",
    reasonText: "未命中过滤规则",
    tags: []
  };
}

export function getEventDisplayRuleMatch(market, ruleId, opts = buildEventIntelOptions()) {
  const classification = market?.classification ?? classifyEventIntelMarket(market, opts);

  if (ruleId === "price" && isBtcPriceDisplayMarket(market)) {
    return {
      ruleId: "price",
      reason: "display-price",
      reasonText: "过滤：BTC Price",
      tags: ["过滤", "BTC Price"]
    };
  }
  if (ruleId === "daily_fixed_template" && classification.fixedTemplate && !classification.priceEvent) {
    return {
      ruleId: "daily_fixed_template",
      reason: "display-fixed-template",
      reasonText: "过滤：日常固定模板",
      tags: ["过滤", classification.templateName ?? "日常固定模板"]
    };
  }
  if (ruleId === "sports_total_goals" && isSportsTotalGoalsMarket(market)) {
    return {
      ruleId: "sports_total_goals",
      reason: "display-sports-total-goals",
      reasonText: "过滤：总进球数",
      tags: ["过滤", "总进球数"]
    };
  }
  if (ruleId === "sports_goal_differential" && isSportsGoalDifferentialMarket(market)) {
    return {
      ruleId: "sports_goal_differential",
      reason: "display-sports-goal-differential",
      reasonText: "过滤：净胜球数",
      tags: ["过滤", "净胜球数"]
    };
  }
  return null;
}

export function isSportsExactScoreMarket(report) {
  const question = marketQuestion(report);
  if (!question) return false;
  if (isSportsSideMarket(report)) return false;
  if (!hasSportsMarketMetadata(report)) return false;

  if (/\b(?:correct score|scoreline|final score)\b/iu.test(question)) return true;
  if (/\s[-–—]\s/u.test(question)) return false;
  return /\bvs\.?\b/iu.test(question);
}

export function isSportsSideMarket(market) {
  if (!hasSportsMarketMetadata(market)) return false;
  const metadata = sportsMarketMetadataText(market);
  return isSportsSideMarketQuestion(marketQuestion(market))
    || /\bsoccer_match_(?:tg|gd)\b/iu.test(metadata);
}

export function isSportsSideMarketQuestion(question) {
  const text = String(question ?? "");
  return /\b(?:total[\s-]+(?:goals?|score)|(?:goals?|score)[\s-]+(?:differential|difference|different)|score[\s-]+diff(?:erential|erence)?|spread|moneyline|winner|draw[\s-]+no[\s-]+bet)\b/iu.test(text)
    || /(?:[总總][进進]球[数數]|[净淨][胜勝]球?[数數])/u.test(text);
}

export function isSportsTotalGoalsMarket(market) {
  if (!hasSportsMarketMetadata(market)) return false;
  const question = marketQuestion(market);
  const metadata = sportsMarketMetadataText(market);
  return /\bsoccer_match_tg\b/iu.test(metadata)
    || (isMatchSideMarketQuestion(question) && /\btotal[\s-]+(?:goals?|score)\b/iu.test(question))
    || (isMatchSideMarketQuestion(question) && /[总總][进進]球[数數]/u.test(question));
}

export function isSportsGoalDifferentialMarket(market) {
  if (!hasSportsMarketMetadata(market)) return false;
  const question = marketQuestion(market);
  const metadata = sportsMarketMetadataText(market);
  return /\bsoccer_match_gd\b/iu.test(metadata)
    || (isMatchSideMarketQuestion(question) && /\b(?:goals?|score)[\s-]+(?:differential|difference|different)|score[\s-]+diff(?:erential|erence)?\b/iu.test(question))
    || (isMatchSideMarketQuestion(question) && /[净淨][胜勝]球?[数數]/u.test(question));
}

function isMatchSideMarketQuestion(question) {
  return /\bvs\.?\b|\bv\.?\b|對|对/u.test(String(question ?? ""));
}

export function isSportsPlayerPropMarket(market) {
  if (!hasSportsMarketMetadata(market)) return false;
  if (isSportsExactScoreMarket(market)) return false;
  if (isSportsSideMarketQuestion(marketQuestion(market))) return false;
  const metadata = sportsMarketMetadataText(market);
  const question = marketQuestion(market);
  return /\bworld_cup_prop\b/iu.test(metadata)
    && /\b(?:star\s+of\s+stars|listed\s+player|best\s+individual\s+performance|player\s+will\s+deliver|golden\s+ball|player\s+of\s+the\s+tournament|top\s+scorer)\b/iu.test(question);
}

export function isMemeIntelMarket(market) {
  const metadata = [
    ...arrayValues(market?.categories),
    ...arrayValues(market?.tags),
    ...arrayValues(market?.topics)
  ].join(" ");
  if (containsTerm(metadata, "Meme")) return true;
  const title = marketQuestion(market);
  if (/\$[^\s?]+.*\bFDV\b/iu.test(title)) return true;
  if (/\$?[\p{Script=Han}A-Za-z0-9]+人生/u.test(title)) return true;
  if (/(?:白毛股神|世界杯|哈基米|熊猫头)/u.test(title)) return true;
  return false;
}

function isLowLiquidityIntelTopic(market) {
  return /\btweet\s+count\b/iu.test(marketQuestion(market));
}

function eventIntelNotifyKey(report, scope = "primary") {
  const market = String(report.market ?? "").trim().toLowerCase();
  if (!market) return "";
  return scope && scope !== "primary" ? `event-intel:${scope}:${market}` : `event-intel:${market}`;
}

function hasEventIntelNotification(opts, key) {
  try {
    return loadSeen(opts.notifySeenFile).has(key);
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      source: "event-intel-notify-seen-load-error",
      file: opts.notifySeenFile,
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
    return false;
  }
}

function markEventIntelNotification(opts, key) {
  try {
    const seen = loadSeen(opts.notifySeenFile);
    seen.add(key);
    saveSeen(opts.notifySeenFile, seen);
  } catch (error) {
    console.error(JSON.stringify({
      level: "warn",
      source: "event-intel-notify-seen-save-error",
      file: opts.notifySeenFile,
      message: errorMessage(error),
      at: new Date().toISOString()
    }));
  }
}

async function postFeishuInteractiveCard(webhook, card) {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Feishu webhook ${response.status}: ${body.slice(0, 200)}`);
}

function formatEventIntelAlertCard(report, opts, reason) {
  const title = reason === "strong-binance"
    ? "重点新事件 · Binance 强相关"
    : reason === "sports-exact-score"
      ? "42 体育事件 · 准确比分"
      : reason === "sports-player-prop"
        ? "42 体育事件 · 球员表现"
        : reason === "meme"
          ? "42 新事件 · Meme"
          : reason === "unfiltered-event"
            ? "42 新事件 · 未过滤"
            : "42 新事件 · 非固定开盘";
  const botName = trimText(opts.notifyBotName || "42space", 24);
  const relation = `${relationLabel(report.binanceRelation.level)} / 推文${socialHeatLabel(report.socialHeat.level)}`;
  const evidence = report.binanceRelation.evidence.slice(0, 2).map((item) => `- ${escapeLarkMd(item)}`).join("\n") || "- 暂无外部证据";
  const buttons = eventIntelActionButtons(report);
  const sportsMatch = reason === "sports-exact-score"
    ? report.sportsMatch ?? buildSportsMatchSummary(report, report.outcomes)
    : null;
  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${escapeLarkMd(trimText(report.question || "未知事件", 160))}**`
      }
    },
    ...formatSportsMatchCardElements(sportsMatch),
    {
      tag: "div",
      fields: [
        fieldMd("开盘", formatBeijingDateTime(report.startDate)),
        fieldMd("创建", formatBeijingDateTime(report.createdAt)),
        fieldMd("间隔", formatCreatedOpenGap(report)),
        fieldMd("来源", formatNotifySources(report))
      ]
    },
    {
      tag: "div",
      fields: [
        fieldMd("Binance / 热度", relation),
        fieldMd("优先级", priorityLabel(report.priority)),
        fieldMd("状态", report.status || "unknown"),
        fieldMd("地址", shortAddress(report.market))
      ]
    },
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**一句话**\n${escapeLarkMd(trimText(report.explanation || "暂无说明", 260))}`
      }
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**证据**\n${evidence}`
      }
    }
  ];
  if (buttons.length) {
    elements.push({
      tag: "action",
      actions: buttons
    });
  }
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: eventIntelCardTemplate(report),
      title: {
        tag: "plain_text",
        content: `${botName} · ${title}`
      }
    },
    elements
  };
}

function fieldMd(label, value) {
  return {
    is_short: true,
    text: {
      tag: "lark_md",
      content: `**${escapeLarkMd(label)}**\n${escapeLarkMd(value || "n/a")}`
    }
  };
}

function eventIntelCardTemplate(report) {
  if (report.binanceRelation.level === "strong") return "red";
  if (["watch", "focus"].includes(report.priority)) return "orange";
  return "blue";
}

function eventIntelActionButtons(report) {
  return [
    { label: "打开 42 市场", url: eventIntelMarketUrl(report), type: "primary" },
    { label: "BscScan", url: bscScanAddressUrl(report.market), type: "default" },
    { label: "REST 数据", url: eventIntelRestUrl(report), type: "default" }
  ].filter((button) => button.url).map((button) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: button.label
    },
    url: button.url,
    type: button.type
  }));
}

function formatSportsMatchCardElements(match) {
  if (!match) return [];
  return [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**对赛 / 比分方向**\n${escapeLarkMd(match.matchupLabel)}\n${escapeLarkMd(match.scoreDirectionLabel)}`
      }
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**比分档位**\n${escapeLarkMd(formatSportsScoreRows(match, 18))}`
      }
    }
  ];
}

function normalizeOutcomeSummaries(outcomes) {
  if (!Array.isArray(outcomes)) return [];
  return outcomes.map((outcome, index) => ({
    index,
    tokenId: stringFirst(outcome?.tokenId, outcome?.id, outcome?.outcomeTokenId),
    name: stringFirst(outcome?.name, outcome?.title, outcome?.label, outcome?.outcomeName),
    price: numberOrNull(outcome?.price),
    payout: numberOrNull(outcome?.payout)
  })).filter((outcome) => outcome.name || outcome.tokenId);
}

function buildSportsMatchSummary(market, outcomes = normalizeOutcomeSummaries(market?.outcomes)) {
  const question = marketQuestion(market);
  if (!hasSportsMarketMetadata(market)) return null;
  if (!question || isSportsSideMarketQuestion(question)) return null;
  if (!/\b(?:correct score|scoreline|final score|vs\.?|v\.?)\b/iu.test(question)) return null;
  const teams = extractSportsMatchTeams(question);
  const scores = extractSportsScoreOutcomes(outcomes);
  if (!teams && scores.length === 0) return null;
  const homeTeam = formatSportsTeam(teams?.home ?? "Team A");
  const awayTeam = formatSportsTeam(teams?.away ?? "Team B");
  const matchupLabel = `${homeTeam.flagLabel} vs ${awayTeam.flagLabel}`;
  return {
    homeTeam,
    awayTeam,
    matchupLabel,
    scoreDirectionLabel: `比分按 ${homeTeam.shortLabel} - ${awayTeam.shortLabel} 排列`,
    scores
  };
}

function hasSportsMarketMetadata(market) {
  return /\b(?:sports?|fifa|world cup|soccer|football|soccer_match|world_cup)\b|世界杯/iu.test(sportsMarketMetadataText(market));
}

function sportsMarketMetadataText(market) {
  return [
    marketQuestion(market),
    ...arrayValues(market?.categories),
    ...arrayValues(market?.subcategories),
    ...arrayValues(market?.topics),
    ...arrayValues(market?.tags)
  ].filter(Boolean).join(" ");
}

function arrayValues(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === "" ? [] : [value];
}

function extractSportsMatchTeams(question) {
  const text = String(question ?? "").trim();
  if (!text) return null;
  const match = text.match(/(?<home>.+?)\s+(?:vs\.?|v\.?)\s+(?<away>.+?)(?:\?|$)/iu);
  if (!match?.groups) return null;
  const home = cleanSportsTeamName(match.groups.home);
  const away = cleanSportsTeamName(match.groups.away);
  if (!home || !away) return null;
  return { home, away };
}

function cleanSportsTeamName(value) {
  return String(value ?? "")
    .replace(/^.*:\s*/u, "")
    .replace(/^.*\b(?:for|of|between)\s+/iu, "")
    .replace(/\s*[-–—]\s*.*$/u, "")
    .replace(/\b(?:correct score|scoreline|final score|match result|match)\b.*$/iu, "")
    .replace(/[?!.,;:]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatSportsTeam(rawName) {
  const raw = String(rawName ?? "").trim();
  const team = WORLD_CUP_TEAM_BY_ALIAS.get(normalizeTeamAlias(raw));
  const formatted = team ?? {
    zh: raw || "未知队伍",
    code: inferTeamCode(raw),
    flag: "🏳️"
  };
  return {
    raw,
    zh: formatted.zh,
    code: formatted.code,
    flag: formatted.flag,
    shortLabel: `${formatted.zh}（${formatted.code}）`,
    flagLabel: `${formatted.flag} ${formatted.zh}（${formatted.code}）`
  };
}

function normalizeTeamAlias(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/['’]/gu, " ")
    .replace(/&/gu, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, " ")
    .trim();
}

function inferTeamCode(rawName) {
  const normalized = normalizeTeamAlias(rawName);
  if (!normalized) return "UNK";
  const latinWords = normalized.match(/[a-z0-9]+/gu) ?? [];
  if (latinWords.length >= 2) return latinWords.map((word) => word[0]).join("").slice(0, 3).toUpperCase().padEnd(3, "X");
  if (latinWords[0]) return latinWords[0].slice(0, 3).toUpperCase().padEnd(3, "X");
  return "UNK";
}

function extractSportsScoreOutcomes(outcomes) {
  const seen = new Set();
  const scores = [];
  for (const outcome of outcomes ?? []) {
    const outcomeName = String(outcome?.name ?? "").trim();
    if (!outcomeName) continue;
    const parsed = parseScoreFromOutcomeName(outcomeName);
    const scoreLabel = parsed ? `${parsed.homeScore}-${parsed.awayScore}` : trimText(outcomeName, 64);
    const dedupeKey = parsed ? `score:${scoreLabel}` : `label:${scoreLabel.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    scores.push({
      scoreLabel,
      homeScore: parsed?.homeScore ?? null,
      awayScore: parsed?.awayScore ?? null,
      outcomeName,
      tokenId: outcome.tokenId || null
    });
  }
  return scores;
}

function parseScoreFromOutcomeName(outcomeName) {
  const match = String(outcomeName ?? "")
    .replace(/[–—]/gu, "-")
    .match(/(?:^|[^\d])(?<home>\d{1,2})\s*(?:-|:)\s*(?<away>\d{1,2})(?:[^\d]|$)/u);
  if (!match?.groups) return null;
  return {
    homeScore: Number(match.groups.home),
    awayScore: Number(match.groups.away)
  };
}

function formatSportsScoreRows(match, maxRows = 18) {
  if (!match.scores.length) return "未从 outcome 中读取到比分档位";
  const rows = match.scores.slice(0, maxRows).map((score) => `- ${formatSportsScoreMeaning(score, match)}`);
  const remaining = match.scores.length - rows.length;
  if (remaining > 0) rows.push(`- 另有 ${remaining} 个比分档位，完整列表见 Markdown/JSON 报告`);
  return rows.join("\n");
}

function formatSportsScoreMeaning(score, match) {
  if (score.homeScore === null || score.awayScore === null) return score.outcomeName;
  const result = score.homeScore > score.awayScore
    ? `${match.homeTeam.shortLabel} 胜`
    : score.homeScore < score.awayScore
      ? `${match.awayTeam.shortLabel} 胜`
      : "平局";
  return `${score.scoreLabel}：${match.homeTeam.shortLabel} ${score.homeScore} - ${score.awayScore} ${match.awayTeam.shortLabel}（${result}）`;
}

function formatEventIntelAlertText(report, opts, reason) {
  const title = reason === "strong-binance"
    ? "重点新事件：Binance 强相关"
    : reason === "sports-exact-score"
      ? "体育事件：准确比分"
      : reason === "sports-player-prop"
        ? "体育事件：球员表现"
        : reason === "meme"
          ? "Meme 新事件"
          : reason === "unfiltered-event"
            ? "未过滤新事件"
            : "非固定新事件";
  return [
    `[${opts.notifyBotName || "42space"}] ${title}`,
    `事件：${report.question}`,
    `地址：${report.market}`,
    `开盘：${formatBeijingDateTime(report.startDate)}`,
    `创建：${formatBeijingDateTime(report.createdAt)}`,
    `间隔：${formatCreatedOpenGap(report)}`,
    `来源：${formatNotifySources(report)}`,
    `Binance：${relationLabel(report.binanceRelation.level)} / 推文热度：${socialHeatLabel(report.socialHeat.level)}`,
    `证据：${report.binanceRelation.evidence.slice(0, 2).join("；")}`,
    `42 市场：${eventIntelMarketUrl(report) || "n/a"}`,
    `BscScan：${bscScanAddressUrl(report.market) || "n/a"}`
  ].join("\n").slice(0, 1800);
}

function eventIntelSkipHeavyReason(classification, opts, market = null) {
  if (classification.fixedTemplate && opts.skipFixed) return "fixed-template";
  if (classification.priceEvent && opts.skipPrice) return "price-event";
  if (isSportsSideMarket(market)) return "sports-side-market";
  return null;
}

function formatNotifySources(report) {
  const sources = Array.isArray(report.discovery?.sources) && report.discovery.sources.length
    ? report.discovery.sources
    : [report.source].filter(Boolean);
  const lower = sources.join(" ").toLowerCase();
  const hasWebsite = lower.includes("rest") || lower.includes("website");
  const hasChain = lower.includes("wss") || lower.includes("chain") || lower.includes("controller");
  if (hasWebsite && hasChain) return "官网 + 链上";
  if (hasWebsite) return "官网";
  if (hasChain) return "链上";
  return sources.join(", ") || "unknown";
}

function formatBeijingDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "n/a";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} 北京时间`;
}

function formatCreatedOpenGap(report) {
  const startMs = new Date(report.startDate ?? "").getTime();
  const createdMs = new Date(report.createdAt ?? "").getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(createdMs)) return "n/a";
  const minutes = Math.max(0, Math.round(Math.abs(startMs - createdMs) / 60_000));
  if (minutes === 0) return "几乎同时创建";
  if (createdMs <= startMs) return `提前 ${minutes} 分钟创建`;
  return `开盘后 ${minutes} 分钟创建`;
}

function eventIntelMarketUrl(report) {
  const address = normalizedAddress(report.market);
  if (!address) return "";
  const route = report.status === "live" ? "live" : "event";
  return `https://www.42.space/${route}/${address}`;
}

function eventIntelRestUrl(report) {
  const address = normalizedAddress(report.market);
  return address ? `https://rest.ft.42.space/api/v1/markets/${address}` : "";
}

function bscScanAddressUrl(address) {
  const normalized = normalizedAddress(address);
  return normalized ? `https://bscscan.com/address/${normalized}` : "";
}

function normalizedAddress(address) {
  const value = String(address ?? "").trim();
  return /^0x[a-fA-F0-9]{40}$/u.test(value) ? value : "";
}

function shortAddress(address) {
  const normalized = normalizedAddress(address);
  return normalized ? `${normalized.slice(0, 6)}...${normalized.slice(-4)}` : "n/a";
}

function escapeLarkMd(text) {
  return String(text ?? "")
    .replace(/\r?\n/gu, "\n")
    .replace(/[<>]/gu, "")
    .trim();
}

function buildIntelQuery(market) {
  const topic = topicQuery(market);
  return `${topic || marketQuestion(market)} Binance BNB "Binance Alpha" "Binance Wallet"`.trim();
}

function buildXQuery(market) {
  const topic = topicQuery(market);
  const core = topic ? `(${topic})` : `"${trimText(stripDateNoise(marketQuestion(market)), 80)}"`;
  return `${core} (Binance OR BNB OR "Binance Alpha" OR "Binance Wallet" OR CZ OR "new product reveal") -is:retweet`.trim();
}

function extractGenericResults(json) {
  const candidates = [];
  collectArrays(json, candidates, 0);
  const rows = candidates
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: stringFirst(item.title, item.name, item.author?.username, item.user?.username, item.screen_name, item.id),
      url: stringFirst(item.url, item.link, item.href, item.tweet_url, item.tweetUrl, item.permalink, item.expanded_url),
      snippet: stringFirst(item.snippet, item.description, item.text, item.full_text, item.content, item.summary),
      authorUsername: stringFirst(item.authorUsername, item.username, item.userName, item.author?.username, item.author?.userName, item.user?.username, item.screen_name),
      authorName: stringFirst(item.authorName, item.author?.name, item.user?.name)
    }))
    .filter((item) => item.title || item.url || item.snippet);
  return rows;
}

function extractTwitterApiIoResults(json) {
  return extractTopLevelItems(json)
    .map((item) => {
      const authorUsername = stringFirst(
        item.authorUsername,
        item.userName,
        item.username,
        item.author?.userName,
        item.author?.username,
        item.user?.username,
        item.screen_name
      ).replace(/^@/u, "");
      const authorName = stringFirst(item.authorName, item.author?.name, item.user?.name);
      const id = stringFirst(item.id, item.tweetId, item.rest_id);
      return {
        title: authorUsername ? `@${authorUsername}` : stringFirst(authorName, id),
        url: stringFirst(item.url, item.tweet_url, item.tweetUrl, item.link, tweetUrlFromParts(authorUsername, id)),
        snippet: stringFirst(item.text, item.full_text, item.content, item.noteTweet?.text),
        authorUsername,
        authorName,
        verified: Boolean(item.verified ?? item.isVerified ?? item.author?.isVerified ?? item.author?.verified),
        metrics: normalizeMetrics(item.public_metrics ?? item.metrics ?? item),
        createdAt: stringFirst(item.createdAt, item.created_at, item.created_at_iso),
        rawId: id
      };
    })
    .filter((item) => item.title || item.url || item.snippet);
}

function extractTopLevelItems(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  for (const key of ["tweets", "data", "results", "items", "statuses"]) {
    if (Array.isArray(json[key])) return json[key];
  }
  for (const key of ["data", "result"]) {
    const value = json[key];
    if (value && typeof value === "object") {
      for (const nestedKey of ["tweets", "items", "results"]) {
        if (Array.isArray(value[nestedKey])) return value[nestedKey];
      }
    }
  }
  return [];
}

function collectArrays(value, output, depth) {
  if (depth > 4 || !value) return;
  if (Array.isArray(value)) {
    for (const item of value) output.push(item);
    return;
  }
  if (typeof value !== "object") return;
  for (const key of ["results", "organic_results", "data", "tweets", "items", "statuses"]) {
    if (Array.isArray(value[key])) collectArrays(value[key], output, depth + 1);
  }
}

function matchBinanceTerms(text) {
  const lower = String(text ?? "").toLowerCase();
  return BINANCE_TERMS.filter((term) => lower.includes(term));
}

function matchStrongBinanceTopic(market) {
  const text = binanceTopicText(market);
  if (!text) return [];
  return BINANCE_STRONG_TOPIC_RULES
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.label);
}

function binanceTopicText(market) {
  return [
    marketQuestion(market),
    market?.title,
    market?.description,
    market?.subtitle,
    market?.resolutionSource,
    market?.source,
    market?.url,
    market?.link
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, positiveInteger(process.env.EVENT_INTEL_MAX_TEXT_CHARS, 6000));
}

function marketContextText(market) {
  return collectStringValues(market, 0, [])
    .join(" ")
    .slice(0, positiveInteger(process.env.EVENT_INTEL_MAX_TEXT_CHARS, 6000));
}

function collectStringValues(value, depth, output) {
  if (depth > 4 || output.length > 120 || value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, depth + 1, output);
    return output;
  }
  if (typeof value === "object") {
    for (const key of [
      "question",
      "title",
      "description",
      "subtitle",
      "ancillaryData",
      "resolutionSource",
      "source",
      "url",
      "link",
      "slug",
      "categories",
      "tags",
      "outcomes",
      "name"
    ]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) collectStringValues(value[key], depth + 1, output);
    }
  }
  return output;
}

function marketQuestion(market) {
  return String(market?.question ?? market?.title ?? "").trim();
}

function templateName(question) {
  if (/Futures Daily Volume/i.test(question)) return "Daily Futures Volume";
  if (/期[貨货]每日交易量|每日(?:成交量|交易量)/u.test(question)) return "Daily Futures Volume";
  if (/Daily Token Usage/i.test(question)) return "Daily Token Usage";
  if (/每日代[幣币](?:(?:總|总)?使用量|使用(?:總|总)?量)/u.test(question)) return "Daily Token Usage";
  if (/OpenRouter/i.test(question)) return "OpenRouter Usage";
  if (/Weekly .*Notional Volume/i.test(question)) return "Weekly Notional Volume";
  if (/Monthly .*Notional Volume/i.test(question)) return "Monthly Notional Volume";
  if (/HIP-[34] total volume/i.test(question)) return "HIP Volume";
  if (/World Cup: Total goals scored in one day/i.test(question)) return "World Cup Daily Total Goals";
  if (/price range/i.test(question)) return "BTC Price Range";
  return "Known Template";
}

function intelFileStem(report) {
  const start = String(report.startDate ?? report.at).replace(/[:.]/g, "-");
  const address = String(report.market ?? "unknown").replace(/^0x/iu, "").slice(0, 10);
  return `event-intel-${start}-${address}`;
}

function eventKindLabel(classification) {
  if (classification.fixedTemplate) return `固定模板（${classification.templateName || "未知模板"}）`;
  if (classification.priceEvent) return "Price 事件";
  return "非固定新事件";
}

function priorityLabel(priority) {
  return {
    focus: "重点关注",
    watch: "观察",
    "watch-light": "轻观察",
    archive: "归档",
    "needs-provider": "待配置数据源"
  }[priority] ?? priority;
}

function relationLabel(level) {
  return {
    strong: "强相关",
    medium: "中相关",
    weak: "弱相关",
    none: "无明显相关",
    unknown: "无法判断"
  }[level] ?? level;
}

function socialHeatLabel(level) {
  return {
    hot: "热门",
    warm: "有热度",
    low: "低热度",
    none: "无明显热度",
    unknown: "无法判断"
  }[level] ?? level;
}

function topicQuery(market) {
  const phrases = topicPhrases(market);
  if (!phrases.length) return "";
  const [first, ...rest] = phrases.slice(0, 4);
  const pieces = [`"${first}"`, ...rest.map((item) => needsQuote(item) ? `"${item}"` : item)];
  return pieces.join(" OR ");
}

function topicPhrases(market) {
  const text = stripDateNoise(marketContextText(market));
  const question = stripDateNoise(marketQuestion(market));
  const phrases = [];
  for (const match of question.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,20})(?:\s+([A-Za-z][A-Za-z0-9]{1,20}))?/gu)) {
    if (match[1] && match[2]) {
      phrases.push(`${match[1]} ${match[2]}`, `$${match[1]} ${match[2]}`);
    } else if (match[1]) {
      phrases.push(`$${match[1]}`, match[1]);
    }
  }
  const sourceMatch = text.match(/Binance\s+([A-Za-z0-9$][A-Za-z0-9$\s-]{1,40}?)\s+Chart/iu);
  if (sourceMatch?.[1]) phrases.push(sourceMatch[1].trim());
  if (phrases.length) {
    return unique(phrases.map((item) => item.replace(/\s+/gu, " ").trim()).filter(Boolean));
  }

  const words = question
    .replace(/[$?.,:;()[\]{}]/gu, " ")
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => word && !topicStopwords().has(word.toLowerCase()) && !/^\d+(?:st|nd|rd|th)?$/iu.test(word));
  if (words.length >= 2) phrases.push(words.slice(0, 2).join(" "));
  if (words[0]) phrases.push(words[0]);
  return unique(phrases.map((item) => item.replace(/\s+/gu, " ").trim()).filter(Boolean));
}

function topicStopwords() {
  return new Set([
    "by",
    "end",
    "of",
    "on",
    "at",
    "will",
    "what",
    "which",
    "price",
    "range",
    "fdv",
    "market",
    "cap",
    "daily",
    "weekly",
    "monthly",
    "june",
    "july",
    "may"
  ]);
}

export function isEventIntelPriceMarket(market) {
  const categoryText = (market?.categories ?? []).join(" ");
  const tagText = (market?.tags ?? []).join(" ");
  const haystack = [
    marketQuestion(market),
    market?.slug,
    categoryText,
    tagText,
    ...(market?.topics ?? [])
  ]
    .filter(Boolean)
    .join(" ");

  if (containsTerm(categoryText, "Price")) return true;
  if (containsTerm(tagText, "Price")) return true;
  if (containsTerm(tagText, "8 hour")) return true;
  if (market?.curve && String(market.curve).toLowerCase() === ADDRESSES.clockCurve.toLowerCase()) return true;
  return /price\s+range|8\s*hour|clock\s*curve/iu.test(haystack) || isPointInTimePriceQuestion(haystack);
}

export function isBtcPriceDisplayMarket(market) {
  if (!isEventIntelPriceMarket(market)) return false;
  const haystack = [
    marketQuestion(market),
    market?.slug,
    ...(market?.categories ?? []),
    ...(market?.tags ?? []),
    ...(market?.topics ?? [])
  ]
    .filter(Boolean)
    .join(" ");
  return /\b(?:btc|bitcoin)\b|比特[币幣]/iu.test(haystack);
}

function containsTerm(text, term) {
  return String(text ?? "").toLowerCase().includes(String(term ?? "").toLowerCase());
}

function isPointInTimePriceQuestion(text) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  return /\bwhat\s+is\s+the\s+price\s+of\s+[\w$./-]+(?:\/[\w$./-]+)?\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm)?\s*utc\b/iu.test(value);
}

function needsQuote(text) {
  return /\s/u.test(text) || text.startsWith("$");
}

function stripDateNoise(text) {
  return String(text ?? "")
    .replace(/\b(on|at)\b/giu, " ")
    .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/giu, " ")
    .replace(/\b20\d{2}\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function withSinceTime(query, searchWindowHours) {
  if (!searchWindowHours || /\b(?:since_time|until_time|since|until):/iu.test(query)) return query;
  const since = Math.floor((Date.now() - searchWindowHours * 60 * 60 * 1000) / 1000);
  return `(${query}) since_time:${since}`;
}

function parseHeaderJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fillTemplate(template, values) {
  return String(template)
    .replaceAll("{query}", encodeURIComponent(values.query))
    .replaceAll("{maxResults}", encodeURIComponent(String(values.maxResults)));
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function classifyBinanceUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./u, "").toLowerCase();
    const binance = BINANCE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!binance) return { binance: false, strong: false, host };
    const path = parsed.pathname.toLowerCase();
    const strong = host === "bnbchain.org" ||
      host.endsWith(".bnbchain.org") ||
      BINANCE_STRONG_URL_PATTERNS.some((pattern) => pattern.test(path));
    return { binance: true, strong, host };
  } catch {
    return { binance: false, strong: false, host: "" };
  }
}

function extractUrls(text) {
  return String(text ?? "").match(/https?:\/\/[^\s"'<>]+/giu) ?? [];
}

function stringFirst(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function trimText(text, max) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function escapeMarkdown(text) {
  return String(text ?? "").replace(/[|]/gu, "\\|").replace(/\n/gu, " ");
}

function tweetUrlFromParts(username, id) {
  if (!username || !id) return "";
  return `https://x.com/${username}/status/${id}`;
}

function normalizeMetrics(metrics) {
  return {
    likeCount: numberFirst(metrics.likeCount, metrics.like_count, metrics.likes, metrics.favorite_count, metrics.favoriteCount),
    retweetCount: numberFirst(metrics.retweetCount, metrics.retweet_count, metrics.retweets),
    replyCount: numberFirst(metrics.replyCount, metrics.reply_count, metrics.replies),
    quoteCount: numberFirst(metrics.quoteCount, metrics.quote_count, metrics.quotes),
    viewCount: numberFirst(metrics.viewCount, metrics.view_count, metrics.views, metrics.impression_count, metrics.impressionCount)
  };
}

function numberFirst(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function engagementScore(result) {
  const metrics = normalizeMetrics(result?.metrics ?? {});
  return metricValue(metrics.likeCount) + metricValue(metrics.retweetCount) * 2 + metricValue(metrics.replyCount) + metricValue(metrics.quoteCount) * 2 + metricValue(metrics.viewCount) / 1000;
}

function formatMetrics(metrics) {
  if (!metrics) return "n/a";
  const normalized = normalizeMetrics(metrics);
  const parts = [];
  if (normalized.likeCount) parts.push(`赞 ${normalized.likeCount}`);
  if (normalized.retweetCount) parts.push(`转 ${normalized.retweetCount}`);
  if (normalized.replyCount) parts.push(`评 ${normalized.replyCount}`);
  if (normalized.quoteCount) parts.push(`引 ${normalized.quoteCount}`);
  if (normalized.viewCount) parts.push(`看 ${normalized.viewCount}`);
  return parts.length ? parts.join(" / ") : "n/a";
}

function unique(values) {
  return [...new Set(values)];
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function errorMessage(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function runSelfTest() {
  const opts = buildEventIntelOptions({ intelOutputDir: "output/event-intel-self-test" });
  const fixed = classifyEventIntelMarket({
    question: "BTC/USDT Futures Daily Volume, May 31st?",
    startDate: "2026-05-31T00:00:00Z",
    createdAt: "2026-05-30T16:56:50Z"
  }, opts);
  assert(fixed.fixedTemplate, "daily volume at 08:00 Beijing should be fixed template");
  const fixedNoonTemplate = classifyEventIntelMarket({
    question: "World Cup: Total goals scored in one day (June 24, 12:00 UTC - June 25, 12:00 UTC)?",
    startDate: "2026-06-24T12:00:00Z",
    createdAt: "2026-06-23T12:00:00Z"
  }, opts);
  assert(fixedNoonTemplate.fixedTemplate, "World Cup one-day total-goals template should be fixed even when it starts at 12:00 UTC");
  const fixedChineseFuturesTemplate = classifyEventIntelMarket({
    question: "BNB/USDT 期貨每日交易量，6月23日？",
    startDate: "2026-06-23T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z"
  }, opts);
  assert(fixedChineseFuturesTemplate.fixedTemplate, "Chinese futures daily-volume template should be fixed");
  const fixedChineseOpenRouterTemplate = classifyEventIntelMarket({
    question: "Hermes Agent 透過 OpenRouter 在 2026 年 6 月 23 日的每日代幣使用總量是多少？",
    startDate: "2026-06-23T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z"
  }, opts);
  assert(fixedChineseOpenRouterTemplate.fixedTemplate, "Chinese OpenRouter daily-token template should be fixed");
  const fixedChineseOpenRouterPythonTemplate = classifyEventIntelMarket({
    question: "哪個 AI 模型在 6 月 23 日於 OpenRouter 上的 Python 使用量最高？",
    startDate: "2026-06-23T00:00:00Z",
    createdAt: "2026-06-22T00:00:00Z"
  }, opts);
  assert(fixedChineseOpenRouterPythonTemplate.fixedTemplate, "Chinese OpenRouter Python usage template should be fixed");
  const nonTemplate = classifyEventIntelMarket({
    question: "Which outcome will have the highest mCap, June 1st?",
    startDate: "2026-05-31T04:00:08Z",
    createdAt: "2026-05-31T04:00:08Z"
  }, opts);
  assert(!nonTemplate.fixedTemplate, "created-at-open short event should be non-template");
  const nearOpenTemplate = classifyEventIntelMarket({
    question: "BTC/USDT Futures Daily Volume, May 31st?",
    startDate: "2026-05-31T00:00:00Z",
    createdAt: "2026-05-30T23:30:01Z"
  }, opts);
  assert(!nearOpenTemplate.fixedTemplate, "template-like market created within 31 minutes of open should notify as non-template");
  const priceEvent = classifyEventIntelMarket({
    question: "Gold (XAU) price range, June 8?",
    categories: ["Price"],
    tags: ["8 hour"],
    curve: ADDRESSES.clockCurve,
    startDate: "2026-05-31T07:55:00Z",
    createdAt: "2026-05-31T07:49:33Z"
  }, opts);
  assert(priceEvent.priceEvent && priceEvent.eventKind === "price-event", "price range markets should be classified as price events");
  assert(eventIntelSkipHeavyReason(priceEvent, opts) === "price-event", "price events should skip heavy enrichment by default");
  const pointPriceEvent = classifyEventIntelMarket({
    question: "What is the price of BTC at 12:00 UTC on 31 May 2026?",
    startDate: "2026-05-31T11:00:08Z",
    createdAt: "2026-05-31T11:00:12Z"
  }, opts);
  assert(pointPriceEvent.priceEvent && pointPriceEvent.eventKind === "price-event", "point-in-time price questions should be classified as price events");
  assert(eventIntelSkipHeavyReason(pointPriceEvent, opts) === "price-event", "point-in-time price questions should skip heavy enrichment by default");
  const pumpPriceRangeMarket = {
    question: "$PUMP price range by end of July 6th ?",
    categories: ["Crypto", "Meme"],
    tags: ["Normal"],
    startDate: "2026-07-02T11:00:00Z",
    createdAt: "2026-07-02T06:01:32Z"
  };
  const pumpPriceRangeClassification = classifyEventIntelMarket(pumpPriceRangeMarket, opts);
  assert(
    pumpPriceRangeClassification.priceEvent && !getEventDisplayFilterDecision(pumpPriceRangeMarket, { eventDisplayFilterRules: ["price"] }, opts).filtered,
    "non-BTC price range markets should remain classified as price events but not be hidden by the display price filter"
  );
  assert(
    getEventDisplayFilterDecision({
      question: "BTC price range, Jun 6th?",
      categories: ["Price"],
      tags: ["8 hour", "automated"]
    }, { eventDisplayFilterRules: ["price"] }, opts).reason === "display-price",
    "BTC price markets should still be hidden by the display price filter"
  );
  const relation = evaluateBinanceRelation({
    market: { question: "Will Binance Alpha list TEST?", description: "Primary Resolution Source: https://www.binance.com/en/support/announcement" },
    webSearch: configuredSource({
      type: "web-search",
      provider: "self-test",
      query: "test",
      results: [{ title: "Binance announcement", url: "https://www.binance.com/en/support/announcement", snippet: "Binance Alpha" }]
    }),
    xSearch: configuredSource({
      type: "x-search",
      provider: "self-test",
      query: "test",
      results: [{ authorUsername: "binance", title: "@binance", snippet: "Binance Alpha update" }]
    })
  });
  assert(relation.level === "strong", "official Binance evidence should be strong");
  const strongTopicCases = [
    {
      name: "BNB comparison",
      market: { question: "HYPE vs BNB: Higher FDV on Dec 31st 2026?" }
    },
    {
      name: "Binance listing",
      market: { question: "Which Asteroid token is listed on Binance by June 30?" }
    },
    {
      name: "Binance official domain",
      market: { question: "$hey stock FDV by end of June 3rd?", description: "Primary Resolution Source: https://web3.binance.com/en/alpha" }
    },
    {
      name: "CZ core person",
      market: { question: "CZ Tweet Count (May 26 - June 2, 2026)?" }
    },
    {
      name: "Chinese Binance topic",
      market: { question: "$币安人生 FDV by end of June 7th?" }
    }
  ];
  for (const testCase of strongTopicCases) {
    const topicRelation = evaluateBinanceRelation({
      market: testCase.market,
      webSearch: notConfiguredSource("web-search"),
      xSearch: notConfiguredSource("x-search")
    });
    assert(
      topicRelation.level === "strong",
      `${testCase.name} should be strong Binance relation`
    );
  }
  const bnbTemplateRelation = evaluateBinanceRelation({
    market: { question: "BNB/USDT Futures Daily Volume, June 2nd?" },
    webSearch: notConfiguredSource("web-search"),
    xSearch: notConfiguredSource("x-search")
  });
  assert(
    bnbTemplateRelation.level !== "strong",
    `BNB fixed template should not be strong from the BNB ticker alone, got ${bnbTemplateRelation.level}`
  );
  const genericChartRelation = evaluateBinanceRelation({
    market: {
      question: "How much will ETH appreciate following Vitalik's post?",
      description: "Resolution Source: https://www.binance.com/en/trade/ETH_USDT?type=spot"
    },
    webSearch: notConfiguredSource("web-search"),
    xSearch: notConfiguredSource("x-search")
  });
  assert(
    genericChartRelation.level !== "strong",
    `Generic Binance chart resolution source should not be strong, got ${genericChartRelation.level}`
  );
  const twitterapi = extractTwitterApiIoResults({
    tweets: [{
      id: "123",
      text: "Binance new product reveal, hey stock is everywhere",
      author: { userName: "binance", name: "Binance", isVerified: true },
      likeCount: 200,
      retweetCount: 50,
      replyCount: 10,
      viewCount: 20000
    }]
  });
  assert(twitterapi[0]?.authorUsername === "binance", "TwitterAPI.io author should normalize");
  assert(twitterapi[0]?.metrics.likeCount === 200, "TwitterAPI.io metrics should normalize");
  const xQuery = buildXQuery({ question: "$hey stock FDV by end of June 3rd?" });
  assert(xQuery.includes("\"hey stock\"") && xQuery.includes("Binance"), "X query should keep compact event topic plus Binance terms");
  assert(eventIntelNotifyReason({
    question: "Gold (XAU) price range, June 8?",
    categories: ["Price"],
    tags: ["8 hour"],
    curve: ADDRESSES.clockCurve,
    classification: priceEvent,
    binanceRelation: relation
  }, { ...opts, notifyNonTemplate: true }) === "unfiltered-event", "non-BTC price events should notify when close-open and not hidden by display filters");
  assert(eventIntelNotifyReason({
    question: "What is the price of BTC at 12:00 UTC on 31 May 2026?",
    classification: pointPriceEvent,
    binanceRelation: relation
  }, { ...opts, notifyNonTemplate: true }) === null, "BTC point-in-time price questions should not notify Feishu by default");
  assert(eventIntelNotifyReason({
    question: "BTC 價格區間，6月23日 12:00 PM UTC？",
    categories: ["Price"],
    tags: ["8 hour"],
    curve: ADDRESSES.clockCurve,
    classification: priceEvent,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2", eventDisplayFilterRules: [] }) === "unfiltered-event", "Bot2 price events should notify when display filters are disabled");
  assert(eventIntelNotifyReason({
    ...pumpPriceRangeMarket,
    classification: pumpPriceRangeClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-3" }) === "meme", "Bot3 should notify non-BTC Meme price-range markets");
  assert(eventIntelNotifyReason({
    question: "BNB/USDT 期貨每日交易量，6月23日？",
    classification: fixedChineseFuturesTemplate,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2", eventDisplayFilterRules: [] }) === "unfiltered-event", "Bot2 daily fixed templates should notify when display filters are disabled");
  const delayedSportsClassification = {
    eventKind: "non-template",
    fixedTemplate: false,
    priceEvent: false,
    createdAtOpen: false
  };
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay",
    categories: ["Sports", "FIFA World Cup"],
    subcategories: ["Football", "Group Stage"],
    topics: ["FIFA World Cup", "Group D"],
    tags: ["soccer_match", "world_cup"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === "sports-exact-score", "delayed FIFA exact-score markets should notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Total Goals",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match", "world_cup"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA total-goals markets should not notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Goal Differential",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match", "world_cup"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA goal-differential markets should not notify Feishu");
  assert(eventIntelNotifyReason({
    question: "約旦 vs 阿根廷 - 總進球數",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA Chinese total-goals markets should not notify Feishu");
  assert(eventIntelSkipHeavyReason(delayedSportsClassification, opts, {
    question: "約旦 vs 阿根廷 - 總進球數",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup_prop"]
  }) === "sports-side-market", "FIFA Chinese total-goals markets should skip heavy enrichment");
  assert(eventIntelNotifyReason({
    question: "阿爾及利亞 vs 奧地利 - 净胜球數",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_gd", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA Chinese goal-differential markets should not notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Total Score",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA total-score markets should not notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Total Score",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2", eventDisplayFilterRules: [] }) === "unfiltered-event", "Bot2 total-score markets should notify when display filters are disabled");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Score Different",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_gd", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }) === null, "FIFA score-different markets should not notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Score Different",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_gd", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2", eventDisplayFilterRules: [] }) === "unfiltered-event", "Bot2 score-different markets should notify when display filters are disabled");
  assert(eventIntelNotifyReason({
    question: "World Cup Star of Stars: Which listed player will deliver the best individual performance?",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["world_cup", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2" }) === "sports-player-prop", "Bot2 FIFA player prop markets should notify Feishu");
  assert(eventIntelNotifyReason({
    question: "$白毛股神 FDV by June 8th?",
    categories: ["Meme"],
    tags: [],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2" }) === "meme", "Bot2 Meme markets should notify Feishu");
  assert(eventIntelNotifyReason({
    question: "HYPE vs BNB: Higher FDV on Dec 31st 2026?",
    categories: ["Crypto"],
    tags: [],
    classification: delayedSportsClassification,
    binanceRelation: { level: "strong" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2" }) === "strong-binance", "Bot2 Binance strong markets should notify Feishu");
  assert(eventIntelNotifyReason({
    question: "Which app will rank higher by June 30?",
    categories: ["Culture"],
    tags: [],
    classification: { ...delayedSportsClassification, createdAtOpen: true },
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-2" }) === "unfiltered-event", "Bot2 generic non-template markets should notify Feishu");
  assert(eventIntelNotifyReason({
    question: "$白毛股神 FDV by June 8th?",
    categories: ["Meme"],
    tags: [],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "Bot5 Console", profileRole: "bot2_like" }) === "meme", "Bot5 bot2_like profile should reuse Bot2 filtered notification rules");
  assert(eventIntelNotifyReason({
    question: "$白毛股神 FDV by June 8th?",
    categories: ["Meme"],
    tags: [],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "Independent Clone", profileRole: "bot2_like" }) === "meme", "bot2_like profile role should work even when the bot name is not Bot2/Bot5");
  assert(eventIntelNotifyReason({
    question: "Which app will rank higher by June 30?",
    categories: ["Culture"],
    tags: [],
    classification: { ...delayedSportsClassification, createdAtOpen: true },
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-3" }) === "unfiltered-event", "Bot3 generic non-template markets should notify Feishu with the filtered-event profile path");
  assert(eventIntelNotifyReason({
    question: "Türkiye vs Paraguay - Total Score",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["soccer_match_tg", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" }
  }, { ...opts, notifyNonTemplate: true }, { botName: "42space-3" }) === null, "Bot3 should keep sports side markets filtered by default");
  const bot2FocusTargets = eventIntelNotificationTargets({ botName: "42space", feishuWebhook: "https://bot1.invalid" }, {
    market: "0x0000000000000000000000000000000000000052",
    question: "World Cup Star of Stars: Which listed player will deliver the best individual performance?",
    categories: ["Sports", "FIFA World Cup"],
    tags: ["world_cup", "world_cup_prop"],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" },
    socialHeat: { level: "unknown" }
  }, { ...opts, notifyNonTemplate: true, bot2NotifyWebhook: "https://bot2.invalid" });
  assert(bot2FocusTargets.some((target) => target.keyScope === "bot2-focus" && target.reason === "sports-player-prop"), "Bot1 watcher should route Bot2 notifications to Bot2 webhook");
  assert(eventIntelNotifyKey({ market: "0x0000000000000000000000000000000000000052" }, "bot2-focus").includes("bot2-focus"), "Bot2 notifications should use an independent dedupe key");
  const bot5FocusTargets = eventIntelNotificationTargets({ botName: "42space", feishuWebhook: "https://bot1.invalid" }, {
    market: "0x0000000000000000000000000000000000000055",
    question: "$白毛股神 FDV by June 8th?",
    categories: ["Meme"],
    tags: [],
    classification: delayedSportsClassification,
    binanceRelation: { level: "none" },
    socialHeat: { level: "unknown" }
  }, { ...opts, notifyNonTemplate: true, bot5NotifyWebhook: "https://bot5.invalid" });
  assert(bot5FocusTargets.some((target) => target.keyScope === "bot5-focus" && target.reason === "meme"), "Bot1 watcher should route Bot5 bot2_like notifications to Bot5 webhook");
  assert(eventIntelNotifyKey({ market: "0x0000000000000000000000000000000000000055" }, "bot5-focus").includes("bot5-focus"), "Bot5 notifications should use an independent dedupe key");
  const bot3FilteredTargets = eventIntelNotificationTargets({ botName: "42space", feishuWebhook: "https://bot1.invalid" }, {
    market: "0x0000000000000000000000000000000000000053",
    question: "Which app will rank higher by June 30?",
    categories: ["Culture"],
    tags: [],
    classification: { ...delayedSportsClassification, createdAtOpen: true },
    binanceRelation: { level: "none" },
    socialHeat: { level: "unknown" }
  }, { ...opts, notifyNonTemplate: true, bot3NotifyWebhook: "https://bot3.invalid" });
  assert(bot3FilteredTargets.some((target) => target.keyScope === "bot3-filtered" && target.reason === "unfiltered-event"), "Bot1 watcher should route Bot3 filtered-event notifications to Bot3 webhook");
  assert(eventIntelNotifyKey({ market: "0x0000000000000000000000000000000000000053" }, "bot3-filtered").includes("bot3-filtered"), "Bot3 filtered notifications should use an independent dedupe key");
  const sampleCard = formatEventIntelAlertCard({
    market: "0x0000000000000000000000000000000000000042",
    question: "Sample non-template event?",
    status: "live",
    startDate: "2026-05-31T07:55:00Z",
    createdAt: "2026-05-31T07:49:33Z",
    source: "self-test",
    discovery: { sources: ["wss", "rest"] },
    classification: nonTemplate,
    explanation: "这个事件用于验证飞书卡片可读性。",
    binanceRelation: relation,
    socialHeat: { level: "warm", score: 3, evidence: [] },
    priority: "watch",
    files: { mdFile: "/tmp/not-clickable.md" }
  }, { notifyBotName: "Bot1" }, "non-template");
  const sampleCardText = JSON.stringify(sampleCard);
  assert(sampleCardText.includes("2026-05-31 15:55 北京时间"), "Feishu card should show Beijing time without ISO T/Z");
  assert(!sampleCardText.includes("T07:55:00Z") && !sampleCardText.includes("not-clickable.md"), "Feishu card should not include ISO time or local report path");
  assert(sampleCardText.includes("https://www.42.space/live/0x0000000000000000000000000000000000000042"), "Feishu card should include clickable 42 market URL");
  const sportsMarket = {
    question: "Japan vs Colombia",
    categories: ["Sports", "FIFA World Cup"],
    subcategories: ["Football", "Group Stage"],
    topics: ["FIFA World Cup"],
    tags: ["soccer_match", "world_cup"],
    outcomes: [
      { tokenId: "1", name: "Japan 1-0 Colombia" },
      { tokenId: "2", name: "0-0" },
      { tokenId: "4", name: "Any Other Score" }
    ]
  };
  const sportsOutcomes = normalizeOutcomeSummaries(sportsMarket.outcomes);
  const sportsMatch = buildSportsMatchSummary(sportsMarket, sportsOutcomes);
  assert(sportsMatch.matchupLabel.includes("🇯🇵 日本（JPN） vs 🇨🇴 哥伦比亚（COL）"), "sports matchup should localize teams with flags and FIFA codes");
  assert(sportsMatch.scores.map((score) => score.scoreLabel).join(",") === "1-0,0-0,Any Other Score", "sports outcomes should preserve score and non-score rows");
  const sportsCard = formatEventIntelAlertCard({
    ...sportsMarket,
    market: "0x0000000000000000000000000000000000000043",
    status: "live",
    startDate: "2026-06-15T19:00:00Z",
    createdAt: "2026-06-01T00:00:00Z",
    source: "self-test",
    discovery: { sources: ["rest"] },
    classification: delayedSportsClassification,
    explanation: "这个事件用于验证世界杯准确比分卡片。",
    binanceRelation: { level: "none", score: 0, evidence: [] },
    socialHeat: { level: "low", score: 0, evidence: [] },
    priority: "archive",
    outcomes: sportsOutcomes,
    sportsMatch
  }, { notifyBotName: "Bot1" }, "sports-exact-score");
  const sportsCardText = JSON.stringify(sportsCard);
  assert(sportsCardText.includes("比分按 日本（JPN） - 哥伦比亚（COL） 排列"), "sports card should state score direction");
  assert(sportsCardText.includes("1-0：日本（JPN） 1 - 0 哥伦比亚（COL）（日本（JPN） 胜）"), "sports card should explain each score against the matchup");
  console.log(JSON.stringify({
    level: "event-intel-self-test",
    passed: 48,
    checks: [
      "fixed template classification",
      "created-at-open non-template classification",
      "31-minute template-like non-template classification",
      "price event classification",
      "price event heavy-enrichment skip",
      "point-in-time price event classification",
      "point-in-time price event heavy-enrichment skip",
      "non-BTC price range display notification",
      "BTC price display filter",
      "Bot3 non-BTC Meme price-range notification",
      "official Binance relation scoring",
      "BNB comparison strong relation",
      "Binance listing strong relation",
      "Binance official domain strong relation",
      "CZ core person strong relation",
      "Chinese Binance topic strong relation",
      "BNB fixed template is not strong by ticker alone",
      "Generic Binance chart source is not strong by itself",
      "TwitterAPI.io tweet normalization",
      "compact X query generation",
      "non-BTC price event Feishu notification",
      "BTC point-in-time price event Feishu notification filter",
      "delayed FIFA exact-score Feishu notification",
      "FIFA total-goals Feishu notification filter",
      "FIFA goal-differential Feishu notification filter",
      "FIFA total-score Feishu notification filter",
      "FIFA score-different Feishu notification filter",
      "Bot2 FIFA player prop Feishu notification",
      "Bot2 Meme Feishu notification",
      "Bot2 Binance strong Feishu notification",
      "Bot2 generic non-template notification filter",
      "Bot5 bot2_like notification filter",
      "generic bot2_like profile role notification filter",
      "Bot3 generic non-template notification filter",
      "Bot3 sports side-market notification filter",
      "Bot2 extra notification route",
      "Bot2 independent notification dedupe key",
      "Bot5 extra notification route",
      "Bot5 independent notification dedupe key",
      "Bot3 extra filtered notification route",
      "Bot3 independent notification dedupe key",
      "Feishu card Beijing time formatting",
      "Feishu card omits local report path",
      "Feishu card includes clickable market URL",
      "sports matchup localized team labels",
      "sports outcome score parsing",
      "sports Feishu card score direction",
      "sports Feishu card score explanations"
    ],
    at: new Date().toISOString()
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
