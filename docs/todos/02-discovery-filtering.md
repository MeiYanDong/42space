# Discovery And Filtering Todo

## Done

- [x] Add REST `status=all` sidecar discovery.
- [x] Make REST discovery inspect raw website markets before filtering, so filtered new markets are still recorded.
- [x] Track `not_started` markets as pending.
- [x] Raise REST scan limit to reduce missing website markets.
- [x] Use open-window deadline to skip stale markets.
- [x] Keep REST discovery non-blocking in both WS and chain-fallback loops so REST cannot delay due execution.

## Next

- [x] Implement `duration >= 48h` auto-buy filter.
- [x] Exclude Price markets from Event auto-buy.
- [x] Normalize `startDate`, `endDate`, and `duration` for every source.
- [x] Add `discoverySource` to market decisions, fills, and dashboard data.
- [x] Add skip reasons: `price-market`, `short-duration`, `missing-time`, `open-window-expired`, `insufficient-data`.
- [x] Verify that chain-discovered and REST-discovered markets pass through the same classifier.
- [x] Keep missing-odds fallback as speed-first `token_order`; `error` remains opt-in only.
- [x] Add fixture tests for:
  - [x] long non-Price Event Market should buy
  - [x] daily futures volume should skip
  - [x] OpenRouter daily usage should skip
  - [x] BTC price range should skip
  - [x] missing end time should skip
- [x] Add regression coverage that REST raw discovery still notices newly filtered markets after the initial seed.

## Update Rule

Update this file after discovery, REST, WSS, market parsing, or filter changes.
