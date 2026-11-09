# Phase 7C — Final Strategy Acceptance gate (TREND + SIDEWAY)

**Checkpoint:** 2026-11-04. **Scope:** source-only, offline synthetic evidence. **Baseline:** core main at commit `9040cd84e7f55509181c2ad97752200a6014eb06`. This file is an **acceptance PLAN / software-only checkpoint**, not a production or trading sign-off.

## 1. Canonical source behavior under review

| Category | TREND | SIDEWAY |
|---|---|---|
| Fresh-entry regime | `TRENDING/BREAKOUT` in AUTO; manual policy subject to mode guard | AUTO recommends `SIDEWAY` with `RANGING`, or separately gated manual mode |
| Entry anchor | Qualified closed M15 pattern (three-candle, two-candle or engulfing) | Supply/Demand range edge (not range center) |
| Other safe-default filters | M15/M5 SuperTrend and valid structure; MA20/MA50 and FVG *not mandatory entry gates* by default | Regime confidence, Supply/Demand corridor, M5 confirmation, recommended mode |
| Initial SL | Structure-derived with +1 XAUUSD price-unit buffer; min distance 6, max 10; wait pullback if >10 | Range boundary plus structure buffer; min distance 6, max 10; reject if >10 |
| +6 price units | Move stop to entry (BE) subject to broker confirmation | Move stop to entry (BE) subject to broker confirmation |
| +10 price units | Attempt close exactly 1/3 (broker min-volume/step subject to validation), leave managed runner | **No automatic software partial close** on current broker TP/SL/trail-only path |
| TP | Optional fixed TP, default disabled in Trend source; not assume a full broker TP always exists | Opposite Supply/Demand boundary, or separately configured broker fixed TP |
| Post-entry trailing | M15 confirmed structure, M5 structural adaptation / fast-move lock, stop may only tighten | Broker TP/SL plus monotonic M5 SL tightening only; no regime/time/partial software close |
| Recovery | Daily Recovery disabled for **new** TREND entries; prior positions not rewritten | Daily Recovery disabled for **new** SIDEWAY entries; prior positions not rewritten |
| REVERSAL exception | LIVE AUTO REVERSAL new-entry hard lock remains mandatory | Not part of approved SIDEWAY acceptance |

**Important:** a legacy SIDEWAY plan may still expose `tp1` or `tp1Kind` and older tests describe a `+10` partial target. That does **not** authorize execution of the older software partial policy after PR #210. Reconcile any customer-facing TP1 labels with the actual current broker target; do not present a disabled legacy target as a promised executed partial.

## 2. Source acceptance test matrix (must be exact-head PASS)

| Test ID | Required synthetic test/evidence |
|---|---|
| S01 | TREND M15 pattern mandatory, SuperTrend M15/M5 and valid structure checked; reject missing enabled condition |
| S02 | SIDEWAY RANGING, range edge, recommended mode, confidence, M5 confirmation; reject center/invalid setup |
| S03 | Recheck mode, fresh quote, candle time and broker account before entry; PAUSE/mismatched AUTO must not send |
| S04 | SL BUY/SELL direction and structure buffer; initial distance 6–10; >10 waits; enforce broker stop/freeze gap |
| S05 | BUY/SELL +6 BE must only tighten, verify broker PATCH success, preserve stop on failure |
| S06 | TREND +10 one-third partial; min-volume/step, duplicate command and restart reconciliation |
| S07 | SIDEWAY after-fill broker TP/SL/trail only; no early time/regime or +10 partial software close |
| S08 | M5 trailing only tightens after successful BE, including same-cycle stale broker snapshot |
| S09 | Fixed TP option must not silently override normal plan or disable broker stop |
| S10 | Daily Recovery no new entry override; old managed positions persist and no recovery lot escalation |
| S11 | LIVE AUTO REVERSAL new-entry lock and source-owner/duplicate execution barriers remain intact |
| S12 | Crash/restart, stale feed, broker command reject, missing fill and ambiguous ticket fail closed |
| S13 | Strategy defaults cannot silently change to permissive values; configured optional filters documented |

This PR adds `scripts/phase7c-final-strategy-acceptance.test.mjs` and a dedicated CI workflow. The workflow re-runs existing negative/regression suites in addition to new cross-strategy checks. A green run supports only these exact offline source tests; it is *not* proof of all real broker cases.

## 3. Mandatory Windows/MT5 DEMO acceptance (not performed by this PR)

1. **Version attestation:** prove the real Windows runtime package/executor/controller hashes match the accepted GitHub source/approved source adapters, report installed Node and broker bridge revisions, record operator-approved config version. Do not assume main commit == deployed runtime.
2. **Pre-trade:** capture real broker DEMO order tickets, time-normalized M15/M5 candles, regime, pattern ID, entry side and full six-condition decisions, quote freshness, spread, stops/freeze levels, lot/balance risk, existing position count. A failing gate must produce no order.
3. **TREND lifecycle:** one controlled BUY and SELL on DEMO; verify initial SL, +6 BE, +10 one-third partial, remainder trailing M15/M5, broker rejection behavior and optional fixed TP. Test pre-+6 stop, reversal/regime change, stale feed and order uncertainty.
4. **SIDEWAY lifecycle:** one controlled BUY and SELL on DEMO; verify range-edge/M5 confirmation, native broker TP/SL, +6 BE and monotonic M5 trailing, **no +10 partial** and **no time/regime software close**. Test disconnection/restart while position already open and after ambiguous broker ACK.
5. **Mode and recovery:** PAUSE/new-entry suppression, AUTO TREND/SIDEWAY arbitration, Daily Recovery new-entry pause, REVERSAL LIVE prohibition (via synthetic guard only; never use real LIVE order to test), manual/SEMI ownership.
6. **Evidence:** before/after ticket IDs masked, broker history, deals, exact timestamps, SL/TP changes, negative-gate logs, no credentials, CI run IDs, screenshots/records, two-side review and sign-off. Retain outside public repo and protect customer data.
7. **Robustness:** backtest out-of-sample and walk-forward on broker-like spread, commissions, slippage; report trade count, profit factor, expectancy, max drawdown, latency, coverage, long/short and regime subgroups. Do **not** declare a profitable strategy from CI alone.

No actual MT5 DEMO orders may be sent without a separately approved manual pilot procedure. Nothing here permits LIVE enablement.

## 4. Acceptance statuses and hard blockers

- **SOURCE REVIEW:** candidate / pending exact-head CI; do not stamp PASS ahead of workflow completion.
- **DEMO BROKER:** NOT VERIFIED by this PR.
- **ACTUAL INSTALLED RUNTIME/CONFIG:** NOT VERIFIED by this PR.
- **FORWARD/WALK-FORWARD PROFITABILITY:** NOT ACCEPTED by this PR.
- **CUSTOMER RELEASE:** BLOCKED separately by #160, #166 and #176. PR #163 COPY_FOLLOWER and #215 anti-rollback synthetic code are not a released follower runtime.
- **OPERATING STATE:** do not touch BOT_MODE, ARM, customer credentials, operator tasks, local deployment, actual MT5 or customer positions. This PR is docs/tests/workflow only.

**Definition of done:** all required exact-head software CI, installed runtime attestation, independent DEMO lifecycle acceptance, repeatable forward/backtest evidence, signed operator acceptance, and relevant customer security gates. **No claim of 100% completion or commercial readiness until those separate records exist.**
