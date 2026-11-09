# Phase 4G — Contribution diagnostics and dataset freeze

## Why

Phase 4F reconciled the current shadow set at 164 unique cases: 109 canonical and 55 rescued. The current replay window also moved from the earlier 550 research cases to 551, so further comparisons must use immutable input files.

Phase 4F also showed that rescued trades are all currently sourced from `VOLUME_PROFILE`. Across the five diagnostic folds their net PnL contribution sums negative, while canonical trades contribute the majority of the positive aggregate result.

## Scope

Phase 4G remains research-only. It does not modify signal generation, structural stop loss, take profit, risk cap, sizing, execution, or production management.

## Dataset freeze

Run `scripts/freeze-phase4-replay-dataset.mjs <work-dir>` before further replay. The script copies:

- `phase4-m15.json`
- `phase4-m5.json`
- `phase4-meta.json`

into an immutable timestamped directory and writes SHA256 hashes to `manifest.json`.

All subsequent Phase 4G / Phase 5 research should point `ZIQ_M15_JSON`, `ZIQ_M5_JSON`, and `ZIQ_META_JSON` to the frozen directory rather than mutable export filenames.

## Contribution diagnostics

`Phase4ContributionDiagnosticsService` evaluates the fixed Phase 4E robust management candidate:

- BE trigger +6
- BE offset +2
- trailing trigger +10
- trailing distance 5

It reports performance for:

- ALL
- CANONICAL
- RESCUED
- BUY
- SELL
- CANONICAL_BUY
- CANONICAL_SELL
- RESCUED_BUY
- RESCUED_SELL

## Decision gate

Do not promote Phase 4 rescue behavior merely because min-lot feasibility increases. Rescued trades must demonstrate positive standalone expectancy and PF > 1 on a frozen dataset and later unseen validation. If rescued contribution remains non-positive, Phase 5 should keep production unchanged and investigate a pre-declared quality filter rather than promoting all compressed entries.
