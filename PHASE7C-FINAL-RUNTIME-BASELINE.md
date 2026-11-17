# Phase 7C Final DEMO Runtime Baseline

Status date: 2026-08-23

This document freezes the verified Phase 7C DEMO baseline after the MT5/Web semantic UI, runtime safety, Telegram control, lot/risk configuration, and read-only smoke verification were completed.

## Verified runtime baseline

The canonical runtime verifier and the final read-only smoke test completed successfully with:

```text
PHASE7C_VERIFY_STATUS=PASS
PHASE7C_SMOKE_VERIFY=PASS
PHASE7C_SMOKE_SEMANTIC_UI=PASS|VERSION=2|STATE=WAITING
PHASE7C_SMOKE_MT5_PANEL=PASS|ORDER_PERMISSION=NONE
PHASE7C_SMOKE_CHART=PASS
PHASE7C_SMOKE_WEB=PASS|HTTP=200
PHASE7C_SMOKE_STATUS=PASS
```

The expected DEMO operating configuration is:

```text
Mode                    AUTO
Trend fixed lot         0.12
Sideway risk            1.00%
Sideway max lot         0.30
Lot application         NEW_POSITIONS_ONLY
MT5 panel permission    NONE
Semantic UI contract    version 2
```

## Safety invariants

The following are release-blocking invariants and must remain unchanged unless a separate reviewed change explicitly updates them:

- DEMO account only.
- MT5 decision panel is read-only and must not send, close, or modify orders.
- `mt5OrderPermission=NONE` must remain present in the MT5 semantic payload.
- Semantic JSON must keep `safety.orderPermission = "NONE"`, `readOnly = true`, `demoOnly = true`, and `newPositionsOnly = true`.
- No martingale.
- No recovery lot escalation.
- Lot/risk setting changes apply to new positions only.
- Managed lot values use 0.03 increments so a +10 partial close can close exactly one-third.
- Sideway management policy: +6 move stop to BE; +10 close 1/3.
- Initial structural stoploss target is 6-10 price units; if stop distance is greater than 10, wait for the qualifying M15 pullback before entry.
- Ownership verification must pass before execution is considered healthy.

## Semantic UI states

The shared MT5/Web contract exposes exactly three primary states:

```text
WAITING
SETUP_READY
MANAGING
```

`WAITING` must not display fake Entry/SL/TP values. `SETUP_READY` may display a validated trade plan. `MANAGING` displays the broker-backed managed position and hold/management reasons.

## AUTO regime behavior

AUTO does not mean "always trade". The regime engine may recommend PAUSE. For example, a REVERSAL regime can correctly result in:

```text
ACTIVE_MODE=AUTO
RECOMMENDED_MODE=PAUSE
DECISION_STRATEGY=PAUSE
DECISION_STAGE=BLOCKED
```

That state is healthy and intentionally blocks new entries.

## Web surfaces

Current primary Web routes are:

```text
Dashboard             /
Signals               /phase7b-pattern-check
Account & Risk        /phase7b-ops
Control Center        /phase7c-control-center
Performance           /performance
```

## Final read-only verification

Run this without restarting or mutating the bot:

```powershell
Set-Location "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master"
$RuntimeWorkDir = Join-Path (Resolve-Path .).Path ".runtime"

.\scripts\smoke-phase7c-runtime-local.ps1 `
  -WorkDir $RuntimeWorkDir
```

A release-candidate runtime is healthy only when the final line is:

```text
PHASE7C_SMOKE_STATUS=PASS
```

## Freeze policy

The following components are considered frozen at this baseline unless a real runtime defect or separately reviewed strategy change requires modification:

- Trend executor
- Sideway executor
- ownership and execution lock safety
- lot/risk engine
- Telegram mode control
- semantic UI contract v2
- MT5 FINAL v5.2 read-only panel
- activation safety gates
- runtime smoke test

Future changes should be isolated, reviewed, and verified before replacing this baseline.