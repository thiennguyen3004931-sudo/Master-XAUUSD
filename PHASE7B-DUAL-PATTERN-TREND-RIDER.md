# Phase 7B — Dual-pattern M15 trend rider

Phase 7B is a research-only candidate. It does not modify Phase 6D, Phase 6E, Phase 7, Phase 7A, production order flow, or broker execution.

## Entry trigger

A signal may be created by either of two M15 price-action patterns.

### 1. Body engulfing

BUY:
- previous M15 candle bearish;
- current M15 candle bullish;
- current open <= previous close;
- current close >= previous open.

SELL is the exact reverse.

### 2. Two-candle body dominance

BUY:
- candle N-2 is bearish;
- candles N-1 and N are both bullish and consecutive;
- `body(N-1) + body(N) > body(N-2)`.

SELL:
- candle N-2 is bullish;
- candles N-1 and N are both bearish and consecutive;
- `body(N-1) + body(N) > body(N-2)`.

If the current candle also qualifies as an engulfing candle, the signal is classified as `ENGULFING`; otherwise it may qualify as `TWO_CANDLE_BODY_DOMINANCE`.

## Mandatory trend filters

BUY requires:
- MA20 > MA50 > MA200;
- signal close > MA20;
- a relevant bullish M15 FVG in the locked lookback that is interacted with by the signal candle/pattern.

SELL requires:
- MA20 < MA50 < MA200;
- signal close < MA20;
- a relevant bearish M15 FVG in the locked lookback that is interacted with by the signal candle/pattern.

An entry pattern that points against the MA trend is rejected.

## Initial stop

The initial stop remains price-based, not USD-risk based.

- Engulfing: structural extreme is the engulfing candle low for BUY / high for SELL.
- Two-candle dominance: structural extreme is the extreme of the three-candle pattern (opposite candle + two same-color candles).
- Structural distance is clamped to 6–10 XAUUSD price units.
- No USD 10 risk cap is used.
- Research replay uses fixed volume, default `0.03` lot.

## Management

### +6 price units

- no partial close;
- move SL exactly to Entry (break-even).

### +10 price units

- close one third of the original position if broker volume step/minimum allows it;
- keep the remaining position as the trend runner.

### After +10

The runner no longer uses a fixed 5-price trailing distance.

Instead, SL follows confirmed M15 swing structure:
- BUY: trail behind confirmed M15 swing lows;
- SELL: trail behind confirmed M15 swing highs;
- SL may only tighten; it may never be widened away from price.

## High-probability reversal exit

To keep this rule objective and tied to the requested MA/FVG framework, Phase 7B currently defines a high-reversal condition as:

- the trade has already reached +10;
- price interacts with an opposing-direction M15 FVG;
- the closed M15 candle rejects that opposing FVG in the reverse direction.

Only then may the remaining runner be closed with `REVERSAL_FVG_REJECTION`.

Touching an opposing FVG by itself is not enough to exit.

The existing MA20 trend-reversal exit remains available as a secondary trend-failure exit.

## Research constraints

- BUY and SELL remain enabled.
- Entry rules are symmetric by side.
- No M5 rescue.
- No USD-risk cap.
- No production mutation.
- No broker orders.
- The current 360-day dataset is already seen data, so Phase 7B results on it are research comparison, not independent validation.
- After Phase 7B rules are frozen, use a new unseen history interval and/or new forward data for validation.

## Local replay

```powershell
$work = "F:\Project\XAUUSD_AI_MASTER\xauusd-ai-master\apps\api\data\historical-replay\work-20260812-154207"

powershell -ExecutionPolicy Bypass -File ".\scripts\run-phase7b-dual-pattern-trend-rider-local.ps1" `
  -WorkDir "$work" `
  -FixedVolume 0.03
```

Expected invariants include:

```text
PHASE7B_TRIGGER=ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE
PHASE7B_MA_TREND=MANDATORY
PHASE7B_FVG=MANDATORY_SAME_DIRECTION
PHASE7B_PLUS6=SL_TO_ENTRY
PHASE7B_PLUS10=PARTIAL_ONE_THIRD
PHASE7B_POST_PLUS10_SL=M15_CONFIRMED_SWING_STRUCTURE_ONLY_TIGHTEN
PHASE7B_REVERSAL_EXIT=OPPOSING_M15_FVG_PLUS_REJECTION_CLOSE_AFTER_PLUS10
PHASE7B_RISK_CAP=OFF
PHASE7B_PRODUCTION_MUTATION=false
```
