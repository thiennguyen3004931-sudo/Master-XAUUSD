# P3 Performance Effectiveness — Design Spec

## Goal
Build a read-only effectiveness layer on top of P2 canonical trade/decision correlation so XAUUSD AI MASTER can quantify which entry and management rules add value, with special first-class measurement of the intrabar Fast-Move Profit Lock.

## Production baseline
- Base main: `b7ccefcbe8f244f161cb85a456e6b04241c58567`.
- P2 production acceptance: 7/7 runtime components `EXACT_MATCH`.
- P3 must not mutate runtime, strategy, risk, orders, positions, bot mode, ARM, AUTO, Fixed TP, recovery, or execution authority.
- P3 recommendations are evidence only and `autoApply=false`.

## Existing Fast-Move contract to preserve
P3 observes but does not change this contract:
- Trend: activation `+10` price; giveback distance `6`; source is live bid/ask.
- Sideway: activation `+10` price; giveback distance `4`; source is live bid/ask.
- Existing `+6 -> BE` remains in force.
- Fast-Move tracks the favorable peak intrabar and proposes `BUY peak-giveback` / `SELL peak+giveback`.
- Stop movement remains monotonic: a management mechanism may tighten but never loosen a tighter known stop.
- Once a fresh confirmed M5 structure exists after the management handoff timestamp, canonical M5 structural trailing takes ownership.

## P3 scope
### P3.1 Canonical effectiveness schema
Create a versioned read-only schema keyed by P2 `tradeKey` / `positionId`. Per trade expose:
- strategy, side, regime, entry type, opening/closing timestamps, entry/exit, initial volume, realized net PnL;
- correlation verdict and evidence;
- passed/blocked rule attribution;
- management events: BE, partial, Fast-Move activation/tighten/handoff, M5 structural tighten, Fixed TP, recovery TP, reversal/other close evidence;
- excursion metrics when candle evidence is sufficient: MFE price, MAE price, MFE in initial-risk R, MAE in initial-risk R;
- realized R when initial structural risk is provable;
- peak-to-exit giveback;
- data-quality flags and explicit unknowns.

No metric may be fabricated from incomplete identity or market evidence. Unknown stays unknown.

### P3.2 Management event attribution
Parse Trend and Sideway execution journals using explicit `ticket` / position identity. Attribute only when the event belongs to exactly one correlated trade. Ambiguous or unmatched management evidence must be reported and excluded from causal summaries.

Recognized management families include:
- `PLUS6_SL_TO_ENTRY` and already-at/tighter equivalents;
- partial-close events around +10;
- Fast-Move activation/tighten/rejected and `FAST_MOVE_HANDOFF_M5_STRUCTURE`;
- `M5_STRUCTURAL_SL_TIGHTEN` and Sideway equivalent;
- Fixed TP close evidence;
- canonical recovery TP evidence;
- reversal/structure/trend close evidence when explicitly journaled.

### P3.3 Excursion reconstruction
Use read-only M5 candles covering `[openedAt, closedAt]` only when timestamp coverage is sufficient. Calculate side-aware MFE/MAE from candle highs/lows. Mark incomplete candle windows as unavailable instead of extrapolating.

### P3.4 Effectiveness aggregates
Aggregate only evidence-qualified rows and always publish sample size and coverage:
- expectancy / net PnL / win rate / profit factor by strategy, regime, entry type and passed rule;
- realized R, MFE-R, MAE-R distributions when initial risk is known;
- management effectiveness by event family;
- Fast-Move: trigger count, average locked distance, peak-to-exit giveback, stop-out-after-trigger count, M5 handoff count, and post-trigger additional MFE.

### P3.5 Fast-Move counterfactual shadow analysis
Read-only/offline only. For trades with sufficient intrabar evidence, replay alternative giveback distances without writing an order or SL. Initial comparison grid:
- Trend: current `6` versus shadow `4`, `5`, `7`, `8`.
- Sideway: current `4` versus shadow `3`, `5`, `6`.

Every counterfactual result must be labeled `SHADOW_ONLY`, include sample size/coverage, and must never become a runtime recommendation when the sample is below the existing minimum recommendation sample of 30.

### P3.6 Read-only API and Control Center
Expose P3 via GET-only localhost API and a collapsed-by-default Control Center card. The card shows overall evidence coverage, strategy expectancy, MFE-to-realized giveback, Fast-Move current-vs-shadow summary, and explicit warnings for insufficient evidence. No save/apply/retune control is allowed.

### P3.7 CI, PR, merge, production acceptance
Add RED/GREEN contract and semantic tests, source safety assertions, API/UI build coverage, then PR/CI/merge. Production acceptance follows P1/P2 provenance: accepted main commit plus 7-component runtime source attestation. No LIVE test order is required or allowed for P3 acceptance.

## Safety invariants
`READ_ONLY=true`
`STRATEGY_MUTATION=false`
`RISK_MUTATION=false`
`ORDER_MUTATION=false`
`POSITION_MUTATION=false`
`MODE_MUTATION=false`
`ARM_MUTATION=false`
`AUTO_RETUNE=false`
`LIVE_TEST_ORDER=false`

## Acceptance criteria
P3 is complete only when:
1. schema and service fail closed on ambiguous correlation or incomplete excursion evidence;
2. current Fast-Move behavior is observable without changing execution code;
3. aggregates always expose sample size and evidence coverage;
4. counterfactuals are shadow-only and cannot write runtime state;
5. API is GET-only/localhost and UI has no mutation path;
6. dedicated CI passes;
7. merged production source is proven by the canonical 7-component attestation.