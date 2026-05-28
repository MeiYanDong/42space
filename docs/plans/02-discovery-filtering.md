# Discovery And Filtering Plan

## Objective

Detect all relevant 42 Event Markets early, but only buy markets that match the strategy.

## Source Model

Use both sources, then normalize into one market record.

| Source | Role | Strength | Limitation |
| --- | --- | --- | --- |
| Chain / WSS controller logs | Fast signal | Can appear immediately around contract creation | Not complete for every visible website market |
| 42 REST `status=all` | Completeness signal | Sees `not_started`, `live`, `startDate`, `endDate`, categories, tags, outcomes | Polling latency and API shape can change |

The buy decision must not depend on whether a market came from chain or REST. Source only affects speed and evidence.

REST discovery must inspect raw website markets before applying the buy filter. A market that is too short, Price, missing time, or otherwise not buyable still needs a `filtered` decision row; otherwise the operator cannot tell whether it was seen and rejected or missed entirely.

## Market Classifier

Normalize every discovered market into:

- title
- category/tag
- market type
- start time
- end time
- duration
- outcomes and odds
- discovery source
- filter result

Then apply one strategy gate.

## Current Strategy Gate

Auto-buy only:

- Event Market
- Not Price
- `duration >= 48h`
- Opened less than `EVENT_OPEN_WINDOW_SECONDS`
- Use odds data when available; if odds are missing in the hot path, keep speed-first `token_order` fallback

Skip:

- Price markets
- Short fixed-cycle templates, for example daily volume, daily token usage, model usage, price range
- Anything older than the open window
- Anything that cannot be normalized safely
- Missing odds only if `EVENT_OUTCOME_SELECTION_FALLBACK=error` is explicitly enabled

## Timing Model

- If `startDate > now`: put into pending, hydrate data, prebuild/presign if possible.
- If `now - startDate <= openWindow`: buy immediately.
- If `now - startDate > openWindow`: skip and persist the skip.

## Current State

The code has REST `status=all` raw discovery, scan limit improvements, the `duration >= 48h` strategy gate, speed-first token-order fallback, and a market decision jsonl for later proof. In WSS mode, REST sidecar polling runs in the background and WSS queues are drained before REST candidates.

## Evidence To Preserve

For each market decision, logs and dashboard should show:

- market title
- start time
- end time
- duration
- source
- decision: pending, bought, skipped
- skip reason, if skipped
- mode: execute or dry-run, so tests cannot be mistaken for real buys
