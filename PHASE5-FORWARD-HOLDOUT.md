# Phase 5 — Fresh Forward Holdout

## Purpose

Phase 4H identified one subgroup that was stable on the frozen research sample: `CANONICAL_SELL`.
Phase 5 is not another optimization phase. It is a pre-registered forward validation that uses only signals strictly after the frozen research cutoff.

## Frozen cutoff and timestamp space

The immutable **real UTC** research cutoff is:

`2026-08-12T12:45:00.000Z`

The corrected MT5 replay feed used for this research encodes the broker server's `+03:00` clock as epoch-like UTC timestamps. On 2026-08-12 the real cutoff therefore maps to this **dataset timestamp** cutoff:

`2026-08-12T15:45:00.000Z`

This +03:00 mapping is a coordinate-system correction only. It does **not** move the pre-registered real-world cutoff or inspect Phase 5 outcomes.

The forward runner verifies `BROKER_HOST_OFFSET_MS` against the pre-registered +03:00 dataset timebase with a five-minute sanity tolerance. A mismatch is a hard failure and no Phase 5 result may be interpreted from that run.

Signals at or before the broker-adjusted dataset cutoff are ignored by `Phase5ForwardHoldoutService`.
Warmup bars before the cutoff are allowed and expected so the canonical strategy can compute MA/structure state correctly, but no pre-cutoff trade can contribute to Phase 5 metrics.

## Candidate locked before forward data

- subgroup: `CANONICAL_SELL`
- entry source: `CANONICAL`
- side: `SELL`
- minimum lot shadow replay: `0.01`
- structural SL/TP: canonical values, unchanged
- management:
  - break-even trigger: `+6`
  - break-even offset: `+2`
  - trailing trigger: `+10`
  - trailing distance: `5`
- intrabar conflict: conservative stop-first behavior inherited from Phase 4 shadow replay

`RESCUED_BUY` is not included even though its aggregate Phase 4G result was positive, because Phase 4H classified it as `UNSTABLE_POSITIVE` (2/5 positive folds).

## Pre-registered sample and pass criteria

Phase 5 must not declare PASS or FAIL until at least **30 filled eligible trades** exist.
Before that point the only valid status is:

`PHASE5_STATUS=INSUFFICIENT_SAMPLE`

After 30 filled eligible trades, PASS requires all of:

- net PnL > 0
- expectancy > 0
- average R > 0
- profit factor > 1.10

Otherwise status is FAIL.

These thresholds are locked before meaningful post-cutoff data exists and must not be changed based on Phase 5 results.

## Data protocol

The frozen Phase 4 M15/M5 files are authoritative for all bars they already contain. A rolling 180-day re-export must never replace or overwrite that pre-cutoff history because historical re-exports were observed to change research counts.

Each Phase 5 run therefore uses three zones:

1. **Frozen authoritative history** — every bar already in the immutable Phase 4 snapshot is retained byte-for-byte.
2. **Bridge warmup** — fresh MT5 bars after the last frozen bar but at/before the broker-adjusted dataset cutoff (`15:45` dataset time) may extend indicator state, but can never score as Phase 5 trades.
3. **Forward holdout** — only fresh bars strictly after the broker-adjusted dataset cutoff may create Phase 5 cases.

The merge must fail when there is no fresh M5 bar strictly after the dataset cutoff.

Use the corrected MT5 exporter (`TIMEFRAME_M15` and `TIMEFRAME_M5`, not M55). Preserve the broker metadata/tick-value method used for the corrected Phase 4 baseline.

For each forward export, keep a timestamped immutable raw export, merged replay snapshot, console log, and SHA256 hashes. Do not overwrite an earlier forward snapshot.

## Output contract

Expected lines include:

```text
PHASE5_REAL_CUTOFF_UTC=2026-08-12T12:45:00.000Z
PHASE5_DATASET_CUTOFF=2026-08-12T15:45:00.000Z
PHASE5_DATASET_OFFSET_MS=10800000
PHASE5_CANDIDATE=CANONICAL_SELL
PHASE5_CONFIG=BE_TRIGGER=6|BE_OFFSET=2|TRAIL_TRIGGER=10|TRAIL_DISTANCE=5
PHASE5_MINIMUM_FILLED_TRADES=30
PHASE5_MINIMUM_PROFIT_FACTOR=1.1
PHASE5_TOTAL_INPUT_CASES=...
PHASE5_PRE_CUTOFF_CASES_IGNORED=...
PHASE5_POST_CUTOFF_CASES=...
PHASE5_ELIGIBLE_CASES=...
PHASE5_FIRST_ELIGIBLE=...
PHASE5_LAST_ELIGIBLE=...
PHASE5_FILLED_TRADES=...
PHASE5_WIN_RATE=...
PHASE5_NET_PNL=...
PHASE5_PROFIT_FACTOR=...
PHASE5_EXPECTANCY=...
PHASE5_AVG_R=...
PHASE5_STATUS=INSUFFICIENT_SAMPLE|PASS|FAIL
PHASE5_PRE_REGISTERED=PASS
PHASE5_PRODUCTION_MUTATION=false
```

Forward runner / merge diagnostics include:

```text
PHASE5_FORWARD_TIMEBASE_STATUS=PASS|FAIL
PHASE5_MERGE_BRIDGE_M15_APPENDED=...
PHASE5_MERGE_BRIDGE_M5_APPENDED=...
PHASE5_MERGE_FORWARD_M15_APPENDED=...
PHASE5_MERGE_FORWARD_M5_APPENDED=...
PHASE5_MERGE_FRESHNESS=PASS|FAIL
```

## Promotion rule

A Phase 5 PASS is necessary but not by itself permission to modify live execution. Production remains unchanged until a separate explicit promotion decision is made after reviewing forward sample size, drawdown/path behavior, operational assumptions, and broker execution constraints.
