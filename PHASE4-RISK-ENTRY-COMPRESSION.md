# Phase 4 — Risk Feasibility & M5 Entry Compression

## Purpose

Phase 4 is a research-only execution refinement lane. It does not change the canonical M15 signal, selected strategy, structural stop-loss, or per-trade risk cap.

The goal is to determine whether an M5 structural retracement can improve the planned entry enough for the broker minimum volume (0.01 lot for the current XAUUSD setup) to fit inside the effective per-trade risk cap.

## Invariants

- Canonical M15 direction is immutable.
- Canonical structural stop-loss is immutable.
- Per-trade risk cap is immutable.
- A compressed entry must be a favorable retracement, not a worse/chasing entry.
- A candidate must not cross the canonical stop-loss.
- A candidate must occur inside the allowed execution window.
- Candidate source must identify a valid execution structure such as FVG, Supply/Demand, MA20/MA50 pullback, Volume Profile, or another explicitly structural source.
- Phase 4 must not alter production-equivalence claims; this is a research lane until replay validates it.

## Risk calculation

For each entry candidate:

`stopTicks = abs(candidateEntry - canonicalStopLoss) / tickSize`

`riskPerLot = stopTicks * tickValuePerLot`

`riskAtMinVolumeUsd = riskPerLot * minVolume`

The candidate is feasible when `riskAtMinVolumeUsd <= effectiveRiskCapUsd`.

## Phase 4 counters

Replay integration should report at least:

- `PHASE4_CANONICAL_EXECUTABLE`
- `PHASE4_CANONICAL_MINLOT_FEASIBLE`
- `PHASE4_CANONICAL_MINLOT_BLOCKED`
- `PHASE4_COMPRESSION_ATTEMPTED`
- `PHASE4_CANDIDATE_FOUND`
- `PHASE4_CANDIDATE_EXPIRED`
- `PHASE4_CANONICAL_STOP_CROSSED`
- `PHASE4_STILL_MINLOT_BLOCKED`
- `PHASE4_MINLOT_RESCUED`
- `PHASE4_FINAL_MINLOT_FEASIBLE`
- `PHASE4_CANONICAL_STOP_PRESERVED`

## Current implementation

`EntryCompressionService` lives in `@xauusd/risk-engine`. It evaluates already-detected M5 structural entry candidates against the canonical M15 entry/stop and instrument risk specification. It deliberately does not detect M5 structures itself; detection remains the responsibility of the analysis/signal execution layer so risk logic stays deterministic and independently testable.
