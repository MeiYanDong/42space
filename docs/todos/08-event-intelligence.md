# Event Intelligence Todo

## Done

- [x] 2026-05-31 define the read-only event intelligence contract for non-template new Event Markets.
- [x] 2026-05-31 classify fixed daily/weekly/monthly templates separately from non-template events so heavy search does not run on the normal 08:00 Beijing batch.
- [x] 2026-05-31 add optional web search and X/Twitter provider configuration without committing provider secrets.
- [x] 2026-05-31 add `event:intel`, a read-only report generator that writes JSONL, JSON, and Chinese Markdown intelligence reports.
- [x] 2026-05-31 wire `event:premium-watch` to start event intelligence asynchronously from the same first-observation path as `premium-watch-seen`, without blocking probe scheduling.
- [x] 2026-05-31 keep fixed-template markets visible through light audit reports while reserving external web/X analysis for non-template events.
- [x] 2026-05-31 add persistent event-intelligence seen-state, seeded from existing JSONL reports, so restarts do not repeat historical markets.
- [x] 2026-05-31 connect the local `twitterapi-io` skill path as the preferred X/Twitter provider, normalize tweet metrics, and surface a tweet heat label in reports.
- [x] 2026-05-31 load TwitterAPI.io credentials from local secret env files so the Skill helper and `42space` runtime share the same lookup path.
- [x] 2026-05-31 tighten X query generation for `$hey stock`-style topics so the search keeps the full phrase and avoids noisy bare-word `hey` matches.
- [x] 2026-05-31 send close-open non-template first-observed events to Bot1 Feishu once per market address, with a separate notification seen file and a 31-minute `createdAt`/`startDate` threshold.
- [x] 2026-05-31 replace event-intelligence Feishu plain text with an operator-facing card: Beijing local times, created/open gap, clickable market/explorer/API buttons, and no server-local report path.
- [x] 2026-05-31 filter Price/price range events out of event-intelligence Feishu alerts by default while keeping local audit reports.
- [x] 2026-05-31 fix point-in-time price questions from WSS receipts, such as `What is the price of BTC at 12:00 UTC`, so they are also classified as Price events when REST categories/tags are unavailable.
- [x] 2026-06-02 promote Binance listing, BNB comparison, CZ/Yi He core-person, official Binance-domain, and Chinese `币安` topics to `strong` relation even when external providers are missing or rate-limited.
- [x] 2026-06-02 connect Bot2's optional `EVENT_INTEL_BUY_FILTER=strong` to the strategy gate, using local/report strong labels without running providers in the buy hot path.
- [x] 2026-06-02 tighten BNB strong-topic handling so BNB comparison remains strong but fixed `BNB/USDT Futures Daily Volume` is not strong from the ticker alone.
- [x] 2026-06-02 make Bot2 strong buy filtering classify/archive fixed templates before local Binance source matching, so official Binance resolution sources on fixed templates cannot revive fixed-buy behavior.
- [x] 2026-06-02 downgrade generic Binance trade/chart/futures resolution sources so non-template price-reference events do not pass Bot2 strong filtering from a data-source URL alone.
- [x] 2026-06-06 keep CZ strong in intelligence reports but exclude `Tweet Count` from Bot2 buy focus as a low-liquidity topic.
- [x] 2026-06-06 connect the follow-rule event library to `event:self-test`, proving requested Meme examples default-follow even when categories are empty while `CZ Tweet Count` does not.
- [x] 2026-06-15 notify Bot1 Feishu for Sports/FIFA exact-score markets even when created well before kickoff, while keeping `Total Goals`, `Total Score`, `Goal Differential`, and `Score Differential` sports side markets archive-only.
- [x] 2026-06-15 add localized Sports/FIFA exact-score matchup summaries with `中文（FIFA code）` team labels, flags, explicit score direction, and full outcome score lists in JSON/Markdown.
- [x] 2026-06-15 reuse the Sports/FIFA exact-score boundary in `即将开盘`: show exact-score markets and hide sports side markets.
- [x] 2026-06-23 add Bot2 profile-local Feishu notifications for all non-filtered events while still tagging Meme, Binance strong, FIFA/Sports exact-score, and World Cup player-performance prop markets as focus classes.
- [x] 2026-06-23 split `world_cup_prop`: Total Score/Score Different stay quiet, but `World Cup Star of Stars`-style player-performance props are no longer hidden as generic sports side markets.
- [x] 2026-06-23 classify Chinese daily fixed templates, World Cup single-day total goals, and Chinese sports side markets such as `總進球數` / `净胜球數` as quiet filters.
- [x] 2026-06-23 make Bot2 Feishu notification filtering follow the runtime display-filter rules, with empty rules meaning all monitored data-complete events notify; shared watchers can read Bot2's runtime-config file.
- [x] 2026-06-26 add Bot3 Feishu notification routing through the same runtime display-filter rules while keeping Bot3's Meme/Binance strong default-follow buy filter disabled.
- [x] 2026-06-26 classify the Chinese OpenRouter Python usage-winner template as a daily fixed template for Bot4 display and archive behavior.
- [x] 2026-06-27 add staged Bot5/Bot2-like Feishu notification routing, runtime display-filter support, independent dedupe scope, and profile-role based Bot2-like notification semantics.
- [x] 2026-07-02 narrow display/Feishu Price filtering to BTC Price only, so non-BTC Meme price-range events can notify Bot2/Bot3/Bot5 filtered profiles while still being archived as price-event intelligence reports.
- [x] 2026-07-02 deploy the BTC-only display Price filter to production, restart `42space-premium-watch.service` plus Bot2/Bot3/Bot5 dashboards, verify the running premium watcher has Bot3 filtered notification routing, and backfill Bot3 notification dedupe for `$PUMP price range by end of July 6th ?` (`0xc2F245E53170cf7C710Aa300f7001e0bF9Eb0c5D`).

## Next

- [ ] Review the next live Bot2/Bot3/Bot5 non-filtered-event Feishu card after the UX revision.
- [ ] Configure `TWITTERAPI_IO_KEY` on the server secret env/profile and confirm the first live non-template report returns `xSearchProvider=twitterapi-io`.
- [ ] Configure the preferred web search provider on the server.
- [ ] Fund Bot2 with at least the current single-market minimum BUSDT when ready; service is running and waiting for funding before the next focus-filter buy.
- [ ] Review the next live Bot2 focus-filter buy/skip decision after funding.
- [ ] Surface event intelligence links in the dashboard after the JSONL format proves stable.

## Update Rule

Update this file after event intelligence classification, provider integration, report format, alerting, or dashboard changes.
