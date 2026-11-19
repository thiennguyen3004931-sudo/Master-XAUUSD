# Phase 4C — Shadow Min-Lot Quality Replay

Phase 4C evaluates the quality of the min-lot feasible set discovered by Phase 4/4B. It remains research-only and does not alter canonical M15 decisions, dynamic sizing, broker orders, DEMO statistics, or LIVE locks.

## Population

The shadow population contains only cases that are feasible at broker minimum volume after Phase 4 evaluation:

- canonical-feasible cases use the canonical entry;
- rescued cases use the selected M5 compressed entry;
- canonical stop-loss is preserved;
- canonical take-profit is preserved;
- volume is fixed to `instrument.minVolume` (currently 0.01 lot).

For the reconciled 180-day replay baseline, Phase 4 reported 108 canonical-feasible plus 55 rescued cases = 163 potential shadow cases before fill simulation.

## Fill model

A shadow trade is opened only if an M5 bar touches the planned entry before the entry expiry time. Planned entries that are never touched remain unfilled and contribute no PnL.

## Intrabar model

M5 OHLC cannot reveal tick ordering. If an already-active stop and take-profit are both touched in the same bar, Phase 4C uses `STOP_FIRST`. Management changes generated from an M5 bar are applied only after that bar's existing stop/TP checks, preventing optimistic same-bar trailing.

## Research management defaults

The first Phase 4C lane is deliberately simple and explicit:

- +6 price units: move stop to entry +0.1 for BUY / entry -0.1 for SELL;
- +10 price units: activate a 4-price-unit trailing stop;
- canonical fixed take-profit remains active.

These values are research parameters, not production settings.

## Metrics

Phase 4C emits:

- `PHASE4C_TOTAL_CASES`
- `PHASE4C_FILLED_TRADES`
- `PHASE4C_UNFILLED_TRADES`
- `PHASE4C_WINS`
- `PHASE4C_LOSSES`
- `PHASE4C_FLAT`
- `PHASE4C_WIN_RATE`
- `PHASE4C_NET_PNL`
- `PHASE4C_PROFIT_FACTOR`
- `PHASE4C_EXPECTANCY`
- `PHASE4C_AVG_R`
- `PHASE4C_AVG_MFE_PRICE`
- `PHASE4C_AVG_MAE_PRICE`
- `PHASE4C_REACHED_PLUS6`
- `PHASE4C_REACHED_PLUS10`
- `PHASE4C_BREAK_EVEN_APPLIED`
- `PHASE4C_TRAILING_ACTIVATED`

## Local historical runner integration

After applying the Phase 4 research hook, run:

```powershell
node .\scripts\apply-phase4c-shadow-hook.mjs ".\apps\api\data\historical-replay\work-20260812-154207\canonical_replay.ts"
```

Then rebuild `@xauusd/risk-engine`, rerun the same historical replay, and inspect `PHASE4C_*` output.

## Invariants

- `PHASE4C_RESEARCH_ONLY=PASS`
- `PHASE4C_MINLOT_FIXED=0.01`
- `PHASE4C_STOP_FIRST=PASS`
- `PHASE4C_PRODUCTION_MUTATION=false`

Do not promote Phase 4C management settings into production from a single in-sample replay. Use the results to decide which management variants deserve walk-forward validation.
