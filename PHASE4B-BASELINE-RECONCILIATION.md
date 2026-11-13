# Phase 4B — Baseline Reconciliation

## Finding

The canonical sizing engine does not target exactly 0.01 lot. `PositionSizeService` calculates raw volume from the approved risk budget and floors it to the broker volume step. Therefore `plan.order.volume === 0.01` is not a valid proxy for whether 0.01 lot is risk-feasible.

On the corrected 180-day M15/M5 replay:

- AI executable: 550
- plan volume exactly 0.01: 23
- Phase 4 canonical min-lot feasible: 108
- canonical min-lot blocked: 442
- min-lot rescued by M5 compression: 55
- final min-lot feasible: 163

The old `REPLAY_EXACT_001_CANDIDATES` metric measures a different condition: the dynamic sizing engine happened to select exactly 0.01 and the later canonical gates passed. It must not be compared directly with `PHASE4_CANONICAL_MINLOT_FEASIBLE`.

## Corrected interpretation

For research on a fixed broker minimum lot:

1. Keep the canonical signal, strategy, entry, SL, TP, AI policy, and dynamic sizing unchanged.
2. Independently evaluate a shadow 0.01-lot lane using the same entry/SL and instrument tick economics.
3. Mark canonical min-lot feasible when risk-at-0.01 is within the configured per-trade cap.
4. For blocked cases only, evaluate M5 structural entry compression while preserving the canonical SL and risk cap.
5. Never write the shadow result back to production execution during Phase 4.

## Baseline

Because the historical exporter was corrected from an invalid M55/75-minute path to true M15 candles, the prior 469 / 38 baseline is no longer apples-to-apples. The corrected baseline for this research lane is:

- 550 AI executable
- 108 canonical min-lot feasible
- 442 canonical min-lot blocked
- 55 rescued by Phase 4 compression
- 163 final min-lot feasible

This corresponds to a 12.44% rescue rate among blocked cases and a 50.93% uplift over canonical min-lot feasible cases.

## Production invariant

`PHASE4_PRODUCTION_EQUIVALENCE=false` remains mandatory. Dynamic production sizing is unchanged until a later promotion decision explicitly adopts a fixed-min-lot execution policy.