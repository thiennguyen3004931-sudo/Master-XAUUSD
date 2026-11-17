# Phase 7B — WAIT_PULLBACK Runtime

## Canonical entry contract

A Phase 7B entry is eligible only when all of these are true:

1. M15 signal is valid.
2. One of the three patterns is valid:
   - `ENGULFING`
   - `TWO_CANDLE_BODY_DOMINANCE`
   - `THREE_CANDLE_BODY_DOMINANCE`
3. Supertrend M15 `(10, 3)` is aligned with the signal side.
4. Supertrend M5 `(10, 3)` is aligned with the signal side.
5. The structural stop is the original pattern extreme and is never loosened to manufacture a smaller stop distance.

Entry state:

- Structural SL distance `<= 10` → `ENTRY_IMMEDIATE`.
- Structural SL distance `> 10` → `WAIT_PULLBACK`.
- While waiting, reevaluate on newly closed M5 bars only.
- If distance compresses to `<= 10`, with structure and both Supertrends still valid → `PULLBACK_ENTRY`.
- Structure break, M15 Supertrend flip, M5 Supertrend flip, or expiry → cancel the waiting setup.
- Conservative same-bar policy: structural invalidation is evaluated before a possible pullback fill.

The DEMO runtime uses a provisional 15-minute wait expiry. Research/shadow expiry remains separately configurable for comparison work.

## Branch

```powershell
git fetch origin
git switch phase7b-wait-pullback-runtime
git pull
```

Do not activate this branch on a real account. Phase 7B runtime retains the DEMO-only account guard and rejects `MT5_ALLOW_REAL_ACCOUNT=true`.

## Stage 1 — Read-only shadow

The shadow runtime reads DEMO bridge data and writes state/journal only. It never sends an order.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-phase7b-wait-pullback-shadow-local.ps1 -WaitMinutes 60
```

Stop it with `Ctrl+C` after collecting enough observations.

Default journal:

```text
.runtime\phase7b-wait-pullback-shadow\phase7b-wait-pullback-shadow-events.jsonl
```

Summarize the journal:

```powershell
node .\scripts\summarize-phase7b-wait-pullback-journal-local.mjs `
  --file=.runtime\phase7b-wait-pullback-shadow\phase7b-wait-pullback-shadow-events.jsonl `
  --out=.runtime\phase7b-wait-pullback-shadow\summary.json
```

Important metrics:

- `PHASE7B_WAIT_SETUP_COUNT`
- `PHASE7B_WAIT_RECOVERED`
- `PHASE7B_WAIT_RECOVERY_RATE_PERCENT`
- `PHASE7B_WAIT_SETUP_INVALIDATED`
- `PHASE7B_WAIT_M15_ST_INVALIDATED`
- `PHASE7B_WAIT_M5_ST_INVALIDATED`
- `PHASE7B_WAIT_EXPIRED`
- `PHASE7B_WAIT_MEDIAN_MINUTES`

## Stage 2 — Upgrade + unarmed DEMO preview

This applies the controller hook with a backup, builds/tests the risk engine, migrates state to version 2, and runs the controller once with `ZIQ_DEMO_ARMED=false`.

It does not send an order.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\upgrade-phase7b-wait-pullback-demo-local.ps1 `
  -WorkDir "F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward" `
  -WaitMinutes 15
```

Required success markers include:

```text
PHASE7B_WAIT_PULLBACK_PATCH=PASS
PHASE7B_WAIT_PULLBACK_BUILD=PASS
PHASE7B_WAIT_PULLBACK_PREVIEW=PASS
PHASE7B_WAIT_PULLBACK_ORDER_SEND=DISABLED_NOT_ARMED
PHASE7B_WAIT_PULLBACK_UPGRADE=PASS
```

## Stage 3 — Guarded DEMO activation

The activation script stops the Phase 7B bot before upgrading and refuses to proceed unless:

- bridge health is OK;
- account mode is `demo`;
- bridge trading is enabled;
- terminal and expert trading are enabled;
- `MT5_ALLOW_REAL_ACCOUNT` is not enabled;
- there are zero open XAUUSD positions;
- persisted state does not contain a managed position;
- persisted state does not contain a pending pullback setup;
- persisted account login matches the current DEMO login.

Validation only, leave bot stopped:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\activate-phase7b-wait-pullback-demo-local.ps1 `
  -WorkDir "F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward"
```

Only after the validation run is clean, start the DEMO bot:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\activate-phase7b-wait-pullback-demo-local.ps1 `
  -WorkDir "F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward" `
  -StartBot
```

For an intentionally clean state reset, only when the broker confirms zero XAUUSD positions:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\activate-phase7b-wait-pullback-demo-local.ps1 `
  -WorkDir "F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward" `
  -ResetBotState
```

## DEMO journal metrics

After DEMO operation, summarize:

```powershell
node .\scripts\summarize-phase7b-wait-pullback-journal-local.mjs `
  --file="F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward\phase7b-demo-forward\phase7b-demo-events.jsonl" `
  --out="F:\Project\XAUUSD\_AI\_MASTER\xauusd-forward\phase7b-demo-forward\wait-pullback-summary.json"
```

The main comparison is not merely trade count. Review immediate entries versus recovered pullback entries, invalidation mix, expiry rate, wait duration, broker rejection rate, and realized results before considering any later production-equivalence work.

## Safety boundaries

- Real-account execution remains disallowed.
- Do not reset state while an XAUUSD position is open.
- Do not treat `SL > 10` as a permanent risk block; it is an entry-timing state.
- Do not move the structural stop farther away during the wait.
- Do not enter from an unfinished M5 bar.
- Existing +6 break-even, +10 partial, structural trailing, FVG reversal, and trend management remain outside the WAIT_PULLBACK entry-state change.
