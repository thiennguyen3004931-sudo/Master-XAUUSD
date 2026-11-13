# Phase 7B DEMO Forward Execution

This lane runs the current Phase 7B strategy on an MT5 **DEMO** account only. It is intentionally separate from historical replay and does not authorize LIVE trading.

## Current strategy

- XAUUSD, BUY and SELL.
- M15 trigger: body engulfing **or** two consecutive same-color candles whose combined bodies exceed the body of the immediately preceding opposite-color candle.
- MA20/MA50/MA200 trend alignment is mandatory.
- Entry gate is **Pattern + MA trend**. Same-direction M15 FVG is **not mandatory for initial entry**.
- Same-direction FVG remains active as a post-entry confirmation signal:
  - `FVG_HOLD_CONFIRMED` records confirmation to keep following the trend while MA alignment remains valid.
  - `FVG_ADDON_SIGNAL_SHADOW` records an add-on/pyramiding opportunity only when the managed position is already favorable.
  - add-on execution is **SHADOW ONLY**: it never sends another MT5 order or increases volume.
  - averaging down / DCA into a losing position is disabled.
- Initial SL distance: 6–10 price units from the actual demo fill.
- +6 price units: move SL to actual entry; no partial close.
- +10 price units: close one third when the broker volume step permits it.
- Remaining position: tighten SL only with confirmed M15 swing structure; never widen the SL.
- After +10 only: opposing M15 FVG plus a rejection close may close the remainder.
- MA20 trend reversal remains a fallback exit.
- No fixed TP (`tp=0`).
- Fixed demo research volume defaults to 0.03 lot.
- Maximum one Phase 7B-managed XAUUSD position at a time.

## Safety invariants

The controller fails closed unless all are true:

- bridge health is OK and connected;
- `accountMode=demo`;
- `MT5_ALLOW_REAL_ACCOUNT=false`;
- bridge trading is enabled;
- terminal automated trading is enabled;
- expert trading is enabled;
- the current DEMO login is explicitly present in `MT5_ALLOWED_LOGINS`;
- there is no unmanaged XAUUSD position when the bot is flat;
- the persisted managed ticket/side/volume still match the broker position after a restart.

A dedicated bridge env template lives at:

`packages/mt5-broker/bridge/.env.phase7b-demo.example`

Copy it to `.env.phase7b-demo`, set a strong `MT5_API_KEY`, and keep `MT5_ALLOW_REAL_ACCOUNT=false`.

## Start sequence

### 1. Create/edit the dedicated demo env

From repository root:

```powershell
Copy-Item ".\packages\mt5-broker\bridge\.env.phase7b-demo.example" ".\packages\mt5-broker\bridge\.env.phase7b-demo"
notepad ".\packages\mt5-broker\bridge\.env.phase7b-demo"
```

Initially leave `MT5_ALLOWED_LOGINS=` blank. Set `MT5_API_KEY` and any terminal/login/server values needed for the DEMO terminal.

### 2. Start the bridge in PowerShell window 1

```powershell
cd ".\packages\mt5-broker\bridge"
.\run.ps1 -EnvFile ".env.phase7b-demo"
```

### 3. Run read-only bot preflight in PowerShell window 2

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase7b-demo-local.ps1" `
  -WorkDir "$work" `
  -FixedVolume 0.03 `
  -Once
```

The preflight prints `PHASE7B_DEMO_ACCOUNT_LOGIN`, `PHASE7B_DEMO_ACCOUNT_MODE`, server, trading flags, and the latest closed-M15 signal preview. The preview also reports whether FVG confirmation is present, but FVG does not block the entry signal. It does not send orders.

### 4. Allow-list the exact DEMO login

Stop the bridge with Ctrl+C, edit `.env.phase7b-demo`, set:

```text
MT5_ALLOWED_LOGINS=<the exact DEMO login printed by preflight>
```

Keep:

```text
MT5_TRADING_ENABLED=true
MT5_ALLOW_REAL_ACCOUNT=false
```

Restart the bridge with the same `run.ps1 -EnvFile` command.

### 5. Arm the DEMO bot

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase7b-demo-local.ps1" `
  -WorkDir "$work" `
  -FixedVolume 0.03 `
  -IntervalSeconds 5 `
  -ArmDemoTrading
```

Stop the controller with Ctrl+C. Do not delete the state file while a managed demo position is open.

## State and journal

The controller persists:

- `phase7b-demo-forward/phase7b-demo-state.json`
- `phase7b-demo-forward/phase7b-demo-events.jsonl`

View them with:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\show-phase7b-demo-status.ps1" -WorkDir "$work" -Tail 40
```

Important events for the new FVG role:

- `ENTRY_SUBMIT` / `ENTRY_FILLED`: initial order based on Pattern + MA; the journal records `fvgConfirmedAtEntry` for analysis.
- `FVG_HOLD_CONFIRMED`: same-direction FVG plus valid MA trend while the position is managed.
- `FVG_ADDON_SIGNAL_SHADOW`: same-direction FVG plus valid MA trend while the position is already winning. This is research telemetry only; `orderSent=false`.

These records are the basis for later recommendations. LIVE/production execution remains unchanged.
