# @xauusd/analysis-engine

Market-structure analysis for XAUUSD AI MASTER.

## Responsibilities

- Swing high/low detection
- Trend and market-structure classification
- BOS and CHOCH detection
- Equal-high/equal-low and liquidity-zone detection
- Order-block detection
- Fair-value-gap detection
- Premium, discount and equilibrium calculation
- Analysis scoring and multi-timeframe confluence

The package consumes candles from `@xauusd/market-data` and shared contracts from
`@xauusd/types`. It does not redefine shared `AnalysisResult`, `SwingPoint`,
`OrderBlock`, `FairValueGap` or `LiquidityZone` models.

## Build

```bash
pnpm --filter @xauusd/types build
pnpm --filter @xauusd/market-data build
pnpm --filter @xauusd/analysis-engine typecheck
pnpm --filter @xauusd/analysis-engine build
pnpm --filter @xauusd/analysis-engine test
```

## Direct candle analysis

```ts
import { AnalysisPipeline } from "@xauusd/analysis-engine";
import { Timeframe, type Candle } from "@xauusd/market-data";

const candles: Candle[] = [];
const result = new AnalysisPipeline().analyze(
  "XAUUSD",
  Timeframe.M15,
  candles,
);
```

The default pipeline requires at least 20 valid, strictly ordered candles. Use a
partial configuration only when a strategy has been calibrated and backtested.

```ts
const engine = new AnalysisPipeline({
  minCandles: 50,
  swing: {
    leftBars: 3,
    rightBars: 3,
    externalStrength: 4,
  },
});
```

## Market-data service integration

```ts
import {
  AnalysisPipeline,
  AnalysisService,
} from "@xauusd/analysis-engine";
import { MarketDataService, Timeframe } from "@xauusd/market-data";

const marketDataService = {} as MarketDataService;
const analysisService = new AnalysisService(
  marketDataService,
  new AnalysisPipeline(),
);

const analysis = await analysisService.analyzeMarket(
  "XAUUSD",
  Timeframe.H1,
  200,
  true,
);
```

## Important

This engine produces technical-analysis evidence. It is not an instruction to
place a live trade. Signal, risk and execution packages must validate every
trade separately.
