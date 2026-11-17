# Phase 7C Decision Observability and MT5 Panel

This change exposes one read-only decision snapshot to the Web Control Center and to an MT5 chart-panel Expert Advisor. It does not add an order endpoint or allow the panel EA to trade. An EA is used because MT5 prohibits `WebRequest` from custom indicators.

## Canonical data flow

- `MarketRegimeClassifier` remains the source of regime, confidence and explanation.
- Trend and Sideway executors write normalized, strategy-specific decision audit files under `.runtime/phase7c-executors/decision-observability`.
- `GET /api/v1/phase7c/decision-monitor` merges the active mode, engine result, active lot settings, exact pre-trade sizing and recent executor decisions.
- `GET /api/v1/phase7c/decision-monitor/mt5` exposes the same snapshot as a line-based read-only payload for MQL5.
- `XAUUSD_AI_Master_Decision_Panel` uses `WebRequest(GET)` only. It contains no `CTrade`, `OrderSend`, position modification or close operation.

## Install on the configured MT5 terminal

Keep the bot in `PAUSE` and update/re-activate the project first. Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\scripts\install-phase7c-mt5-decision-panel-local.ps1
```

In MT5:

1. Open `Tools > Options > Expert Advisors`.
2. Enable `Allow WebRequest for listed URL` and add `http://127.0.0.1:3711`.
3. In Navigator, refresh Expert Advisors.
4. Attach `XAUUSD_AI_MASTER\XAUUSD_AI_Master_Decision_Panel` to the XAUUSD chart.

The panel shows active/effective mode, engine regime/confidence, entry stage, side/setup, entry/SL, raw/final/capped lot, estimated risk, BE, TP1/TP2 and the current decision/limit reasons. `ORDER PERMISSION = NONE` must remain visible.

## Runtime safety

- DEMO only.
- The configured lot applies only to new positions after a safe executor restart.
- Existing positions are never resized by this feature.
- No martingale or recovery lot escalation.
- MT5 panel and both monitor endpoints are read-only.
