# @xauusd/signal-engine

Production signal-generation package for XAUUSD AI MASTER.

## Responsibilities

- Consume `DetailedAnalysisResult` from `@xauusd/analysis-engine`.
- Consume `IndicatorReport` from `@xauusd/indicators`.
- Score bullish and bearish confluence through independent rules.
- Reject incomplete, low-quality, low-confidence, low-edge or abnormal-volatility setups.
- Generate a shared `Signal` from `@xauusd/types` only when every gate passes.
- Calculate Entry, Stop Loss, Take Profit, Risk:Reward and TP1/TP2/TP3.
- Return `WAIT` with explicit rejection codes instead of forcing a trade.

## Default scoring model

The 13 default rules have a total weight of 100:

- Trend: 13
- Market structure: 13
- BOS/CHOCH event: 10
- EMA alignment: 10
- MACD: 9
- RSI: 7
- ADX: 8
- Stochastic: 5
- Premium/discount location: 8
- Liquidity: 5
- Order block: 5
- Fair value gap: 4
- Volume: 3

The default minimums are 62% confidence, 14% directional edge, analysis score 45,
data quality 95 and minimum Risk:Reward 1.8.

## Usage with prepared analysis and indicators

```ts
import { SignalPipeline } from "@xauusd/signal-engine";

const engine = new SignalPipeline();
const result = engine.generate({ analysis, indicators });

if (result.signal) {
  console.log(result.decision, result.signal);
  console.log(result.levels?.partialTargets);
} else {
  console.log("WAIT", result.diagnostics.rejectionCodes);
}
```

## End-to-end usage from candles

```ts
import { SignalService } from "@xauusd/signal-engine";
import { Timeframe } from "@xauusd/market-data";

const service = new SignalService();
const result = service.generateFromCandles("XAUUSD", Timeframe.M15, candles);
```

## Safety boundary

This package generates analysis outputs only. It does not place orders and does not
bypass the risk engine. Every accepted signal must still pass `@xauusd/risk-engine`
before execution.

## Commands

```bash
pnpm --filter @xauusd/signal-engine typecheck
pnpm --filter @xauusd/signal-engine build
pnpm --filter @xauusd/signal-engine test
```
