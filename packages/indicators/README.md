# @xauusd/indicators

Technical-indicator package for XAUUSD AI MASTER. It owns deterministic,
side-effect-free calculations over candles from `@xauusd/market-data`.

## Included indicators

- SMA and EMA with configurable price sources
- ATR using Wilder smoothing
- RSI using Wilder smoothing
- MACD, signal and histogram
- Bollinger Bands, bandwidth and percent-B
- Stochastic %K and %D
- ADX, +DI and -DI
- Cumulative VWAP
- Volume SMA

Every series is aligned with the input candle array. Warm-up entries are `null`
rather than shortened arrays, making the result safe to align with charts,
analysis output and future signal generation.

## Build and test

```bash
pnpm --filter @xauusd/types build
pnpm --filter @xauusd/market-data build
pnpm --filter @xauusd/indicators typecheck
pnpm --filter @xauusd/indicators build
pnpm --filter @xauusd/indicators test
```

## Usage

```ts
import { IndicatorPipeline } from "@xauusd/indicators";

const report = new IndicatorPipeline().calculate(candles, {
  smaPeriods: [20, 50, 200],
  emaPeriods: [9, 21, 50, 200],
});

console.log(report.latest.rsi);
console.log(report.latest.atr);
console.log(report.latest.macd.histogram);
```

## Price sources

Moving averages, RSI, MACD and Bollinger Bands support `open`, `high`, `low`,
`close`, `hl2`, `hlc3` and `ohlc4`.

## Dependency boundary

This package imports shared contracts from `@xauusd/types` and candle ownership
from `@xauusd/market-data`. It does not depend on analysis, signal, risk,
strategy or execution packages, preventing reverse dependencies and cycles.
