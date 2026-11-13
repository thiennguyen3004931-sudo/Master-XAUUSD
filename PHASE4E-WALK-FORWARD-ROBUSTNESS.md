# Phase 4E — Walk-forward robustness

Phase 4E validates the Phase 4D management neighborhood without changing canonical M15 signals, M5 entry compression, structural stop-loss, take-profit, minimum lot, risk cap, or production execution.

## Candidate neighborhood

Phase 4D identified the useful region around:

- break-even trigger: +6 price units
- positive stop offset: +1 to +2 price units
- trailing trigger: +10 to +12 price units
- trailing distance: +5 to +7 price units

Phase 4E evaluates 18 combinations:

- BE trigger: 6 (fixed)
- BE offset: 1 / 1.5 / 2
- trailing trigger: 10 / 12
- trailing distance: 5 / 6 / 7

## Walk-forward protocol

The shadow cases are sorted chronologically by canonical signal timestamp and split into 5 contiguous folds.

Walk-forward tests:

1. Fold 1 trains, Fold 2 tests.
2. Folds 1–2 train, Fold 3 tests.
3. Folds 1–3 train, Fold 4 tests.
4. Folds 1–4 train, Fold 5 tests.

The management configuration is selected only from prior folds using training expectancy, then profit factor and net PnL as tie-breakers. The selected configuration is evaluated on the next unseen fold.

## Robustness gate

A configuration is considered robust only when all of the following hold:

- positive expectancy in at least 3 of 5 folds;
- profit factor > 1 in at least 3 of 5 folds;
- positive net PnL in at least 3 of 5 folds;
- aggregate expectancy > 0;
- aggregate profit factor > 1.

Among robust configurations, ranking prioritizes:

1. number of positive-expectancy folds;
2. number of PF>1 folds;
3. number of positive-PnL folds;
4. worst-fold expectancy;
5. average fold expectancy;
6. total net PnL.

## Required outputs

The replay hook prints:

- `PHASE4E_TOTAL_CASES`
- `PHASE4E_FOLDS`
- `PHASE4E_CONFIGS`
- one `PHASE4E_OOS_FOLD` line per unseen fold
- `PHASE4E_OOS_FILLED`
- `PHASE4E_OOS_WIN_RATE`
- `PHASE4E_OOS_NET_PNL`
- `PHASE4E_OOS_PROFIT_FACTOR`
- `PHASE4E_OOS_EXPECTANCY`
- `PHASE4E_OOS_AVG_R`
- `PHASE4E_OOS_POSITIVE_FOLDS`
- `PHASE4E_ROBUST_CONFIGS`
- `PHASE4E_ROBUST_BEST`
- `PHASE4E_RESEARCH_ONLY=PASS`
- `PHASE4E_PRODUCTION_MUTATION=false`

## Promotion rule

Phase 4E is research-only. Do not promote management parameters to production merely because a full-sample sweep is profitable.

A Phase 5 candidate should require, at minimum, positive OOS expectancy and PF>1, multiple positive OOS folds, and at least one robust configuration under the gate above. If those conditions fail, retain Phase 4 as research and revise management or trade selection rather than weakening the gate.
