export const FOLLOW_RULE_LIBRARY_CONFIG = {
  minEventDurationHours: 0,
  marketCategoryAllowlist: [],
  marketCategoryBlocklist: ["Price"],
  marketTagBlocklist: ["Price", "8 hour", "automated"],
  eventIntelBuyFilter: "strong",
  eventIntelBuyFile: "data/missing-event-library-intel.jsonl"
};

const BASE_START = "2030-06-14T00:00:00.000Z";
const BASE_END = "2030-06-30T00:00:00.000Z";

export const FOLLOW_RULE_EVENT_LIBRARY = [
  {
    id: "meme-apple-life-vs-us-stock-life",
    note: "Meme board event should default-follow even without Binance strong evidence.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005101",
      question: "$苹果人生 vs. $美股人生: Higher FDV on 14th June 2026?",
      categories: []
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "meme-white-hair-stock-god-fdv",
    note: "Meme FDV event should default-follow.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005102",
      question: "$白毛股神 FDV by June 8th?",
      categories: []
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "meme-world-cup-fdv",
    note: "Crypto/Meme FDV event should default-follow.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005103",
      question: "$世界杯 FDV by end of June 19th?",
      categories: []
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "meme-binance-life-fdv",
    note: "Chinese Binance meme should default-follow through Meme and also remains Binance-related.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005104",
      question: "$币安人生 FDV by end of June 7th?",
      categories: ["Meme"]
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "meme-hakimi-binance-first",
    note: "Meme event with loose Binance wording should default-follow by board, not weak relation score.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005105",
      question: "哈基米 to Futures/Spot vs 熊猫头 to Binance — which's first by June 30?",
      categories: [],
      tags: ["Early Resolution"]
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "binance-cz-tweet-count-low-liquidity",
    note: "CZ is Binance-related, but Tweet Count markets are too low-volume for default buy.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005106",
      question: "CZ Tweet Count (June 5 - June 12, 2026)?",
      categories: ["Culture"]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-low-liquidity",
      defaultFollowed: false,
      tagsAny: ["Tweet Count"],
      displayVisible: true,
      displayNotify: true,
      displayReason: "display-non-template",
      displayTagsAny: ["默认显示"]
    }
  },
  {
    id: "binance-bnb-comparison-strong",
    note: "Non-template Binance strong comparison should still default-follow.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005107",
      question: "HYPE vs BNB: Higher FDV on Dec 31st 2026?",
      categories: ["Crypto"]
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Binance strong"]
    }
  },
  {
    id: "meme-category-generic",
    note: "A generic market explicitly categorized as Meme should default-follow even without title heuristics.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005109",
      question: "Generic community token outcome by June 30?",
      categories: ["Meme"]
    }),
    expected: {
      eligible: true,
      reason: "eligible",
      defaultFollowed: true,
      tagsAny: ["Meme 默认关注"]
    }
  },
  {
    id: "price-range-still-excluded",
    note: "Price events remain excluded even if they are common in the feed.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005108",
      question: "BTC price range, Jun 6th?",
      categories: ["Price"],
      tags: ["8 hour", "automated"]
    }),
    expected: {
      eligible: false,
      reason: "price-market",
      defaultFollowed: false,
      tagsAny: ["Price"],
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-price"
    }
  },
  {
    id: "sports-exact-score-display-only",
    note: "FIFA/Sports exact-score markets should display and notify, but not default-follow unless manually planned/followed.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005110",
      question: "Japan vs Colombia",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match", "world_cup"],
      outcomes: [
        { tokenId: "1", name: "JPN 1-0 COL", price: 0.01, payout: 0.03 },
        { tokenId: "2", name: "JPN 0-0 COL", price: 0.01, payout: 0.03 },
        { tokenId: "4", name: "JPN 0-1 COL", price: 0.01, payout: 0.03 }
      ]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-missing",
      defaultFollowed: false,
      displayVisible: true,
      displayNotify: true,
      displayReason: "display-sports-exact-score",
      displayTagsAny: ["准确比分"]
    }
  },
  {
    id: "sports-total-goals-side-market-hidden",
    note: "World Cup total-goals side markets should be filtered while exact-score markets remain visible.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005112",
      question: "約旦 vs 阿根廷 - 總進球數",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match_tg", "world_cup_prop"]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-missing",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-sports-total-goals",
      displayTagsAny: ["总进球数"]
    }
  },
  {
    id: "sports-goal-differential-side-market-hidden",
    note: "World Cup goal-differential side markets should be filtered explicitly.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005113",
      question: "阿爾及利亞 vs 奧地利 - 净胜球數",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["soccer_match_gd", "world_cup_prop"]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-missing",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-sports-goal-differential",
      displayTagsAny: ["净胜球数"]
    }
  },
  {
    id: "world-cup-total-goals-daily-template-hidden",
    note: "World Cup single-day total-goals markets are daily templates and should be filtered.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005114",
      question: "World Cup: Total goals scored in one day (June 24, 12:00 UTC - June 25, 12:00 UTC)?",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["world_cup"],
      startDate: "2030-06-24T12:00:00.000Z",
      createdAt: "2030-06-23T00:00:00.000Z"
    }),
    expected: {
      eligible: false,
      reason: "event-intel-archive",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-fixed-template",
      displayTagsAny: ["World Cup Daily Total Goals"]
    }
  },
  {
    id: "chinese-futures-daily-volume-template-hidden",
    note: "Chinese futures daily-volume markets are daily fixed templates and should be filtered.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005115",
      question: "BNB/USDT 期貨每日交易量，6月23日？",
      categories: ["Crypto"],
      tags: ["Normal"],
      startDate: "2030-06-23T00:00:00.000Z",
      createdAt: "2030-06-22T00:00:00.000Z"
    }),
    expected: {
      eligible: false,
      reason: "event-intel-archive",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-fixed-template",
      displayTagsAny: ["Daily Futures Volume"]
    }
  },
  {
    id: "chinese-openrouter-daily-token-template-hidden",
    note: "Chinese OpenRouter daily token usage markets are daily fixed templates and should be filtered.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005116",
      question: "Hermes Agent 透過 OpenRouter 在 2026 年 6 月 23 日的每日代幣使用總量是多少？",
      categories: ["AI"],
      tags: ["Normal"],
      startDate: "2030-06-23T00:00:00.000Z",
      createdAt: "2030-06-22T00:00:00.000Z"
    }),
    expected: {
      eligible: false,
      reason: "event-intel-archive",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-fixed-template",
      displayTagsAny: ["Daily Token Usage"]
    }
  },
  {
    id: "chinese-openrouter-python-usage-template-hidden",
    note: "Chinese OpenRouter Python usage markets are daily fixed templates and should be filtered.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005117",
      question: "哪個 AI 模型在 6 月 23 日於 OpenRouter 上的 Python 使用量最高？",
      categories: ["AI"],
      tags: ["Normal"],
      startDate: "2030-06-23T00:00:00.000Z",
      createdAt: "2030-06-22T00:00:00.000Z"
    }),
    expected: {
      eligible: false,
      reason: "event-intel-archive",
      defaultFollowed: false,
      displayVisible: false,
      displayNotify: false,
      displayReason: "display-fixed-template",
      displayTagsAny: ["OpenRouter Usage"]
    }
  },
  {
    id: "sports-star-of-stars-display-only",
    note: "World Cup player-performance prop markets should display and notify, but not default-follow.",
    market: eventMarket({
      address: "0x523B1055d07b49ACE6A615e30B843CE8e86742B6",
      question: "World Cup Star of Stars: Which listed player will deliver the best individual performance?",
      categories: ["Sports", "FIFA World Cup"],
      tags: ["world_cup", "world_cup_prop"],
      outcomes: [
        { tokenId: "1", name: "Cristiano Ronaldo", price: 0.003, payout: 0.02 },
        { tokenId: "2", name: "Lionel Messi", price: 0.003, payout: 0.02 },
        { tokenId: "4", name: "Neymar Jr", price: 0.003, payout: 0.02 }
      ]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-missing",
      defaultFollowed: false,
      displayVisible: true,
      displayNotify: true,
      displayReason: "display-sports-player-prop",
      displayTagsAny: ["球员表现"]
    }
  },
  {
    id: "generic-non-template-display-only",
    note: "Non-template events outside Meme/Binance/Sports focus should display and notify, but should not default-follow.",
    market: eventMarket({
      address: "0x0000000000000000000000000000000000005111",
      question: "Which app will rank higher by June 30?",
      categories: ["Culture"],
      tags: ["Normal"]
    }),
    expected: {
      eligible: false,
      reason: "event-intel-missing",
      defaultFollowed: false,
      displayVisible: true,
      displayNotify: true,
      displayReason: "display-non-template",
      displayTagsAny: ["默认显示"]
    }
  }
];

function eventMarket(overrides = {}) {
  return {
    status: "not_started",
    createdAt: "2030-06-13T23:55:00.000Z",
    startDate: BASE_START,
    endDate: BASE_END,
    contractVersion: 2,
    curve: "0xDC26047458FEa8Bd45164217CCb7eE90b9bE10B8",
    categories: ["Crypto"],
    tags: ["Normal"],
    outcomes: [
      { tokenId: "1", name: "Option A", price: 0.001, payout: 0.003 },
      { tokenId: "2", name: "Option B", price: 0.001, payout: 0.003 },
      { tokenId: "4", name: "Option C", price: 0.001, payout: 0.003 }
    ],
    ...overrides
  };
}
