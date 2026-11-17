# Phase 4H — Subgroup Stability Diagnostics

## Purpose

Phase 4G showed materially different aggregate outcomes across four research-only subgroups:

- `CANONICAL_BUY`
- `CANONICAL_SELL`
- `RESCUED_BUY`
- `RESCUED_SELL`

Phase 4H does **not** optimize parameters and does **not** promote a subgroup filter to production. It asks whether the aggregate Phase 4G result is stable across common chronological folds or is dominated by one regime.

## Frozen management configuration

Phase 4H keeps the Phase 4G management fixed:

- break-even trigger: `+6`
- break-even offset: `+2`
- trailing trigger: `+10`
- trailing distance: `5`
- fixed replay volume: `0.01`
- canonical structural stop preserved
- research only

## Fold design

The full frozen shadow-case set is sorted by `signalTimestamp` and divided into 5 contiguous chronological folds. The same fold boundaries are used for all four subgroups.

This is intentionally different from splitting each subgroup independently because Phase 4H is testing regime stability, not forcing equal subgroup sample sizes per fold.

## Stability rule

A subgroup is `STABLE_POSITIVE` only when:

1. aggregate net PnL > 0,
2. aggregate expectancy > 0,
3. aggregate profit factor > 1,
4. the subgroup is active in at least 3 folds, and
5. at least 60% of active folds have positive expectancy, PF > 1, and positive net PnL.

A subgroup with positive aggregate metrics but insufficient fold stability is `UNSTABLE_POSITIVE`.

A subgroup with non-positive aggregate edge is `NON_POSITIVE`.

## Output

Expected replay counters include:

```text
PHASE4H_CONFIG=...
PHASE4H_FOLDS=5
PHASE4H_GROUP=CANONICAL_BUY|...
PHASE4H_FOLD=1|GROUP=CANONICAL_BUY|...
...
PHASE4H_GROUP=CANONICAL_SELL|...
PHASE4H_GROUP=RESCUED_BUY|...
PHASE4H_GROUP=RESCUED_SELL|...
PHASE4H_STABLE_POSITIVE_GROUPS=...
PHASE4H_RESEARCH_ONLY=PASS
PHASE4H_PRODUCTION_MUTATION=false
```

## Decision rule

Phase 4H is diagnostic evidence only. Even if one or more subgroups are `STABLE_POSITIVE`, the next promotion gate is an untouched/fresh chronological validation window. Phase 4G/4H data must not be reused as the final production-validation sample.
