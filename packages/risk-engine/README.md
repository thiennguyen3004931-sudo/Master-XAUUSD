# @xauusd/risk-engine

Production-oriented risk gate for XAUUSD AI MASTER.

The package receives an accepted result from `@xauusd/signal-engine`, combines it with account, portfolio and instrument telemetry, then either:

- approves a normalized `Order`; or
- rejects the trade with explicit machine-readable reason codes.

## Core controls

- Confidence- and strength-adjusted risk budget
- Drawdown and consecutive-loss risk reduction
- Fixed portfolio open-risk ceiling
- Daily loss limit
- Maximum drawdown limit
- Total and per-symbol position limits
- Loss cooldown
- Spread filter
- Minimum risk-to-reward filter
- Tick-value-aware position sizing
- Broker volume-step normalization
- Projected margin and free-margin controls

## XAUUSD instrument example

```ts
const xauusd = {
  symbol: "XAUUSD",
  tickSize: 0.01,
  tickValuePerLot: 1,
  contractSize: 100,
  minVolume: 0.01,
  maxVolume: 10,
  volumeStep: 0.01,
  maxSpread: 0.5,
  priceDigits: 2,
};
```

Broker specifications vary. Always replace these values with the exact symbol properties supplied by the connected broker.

## Usage

```ts
import { RiskPipeline } from "@xauusd/risk-engine";

const result = new RiskPipeline({
  baseRiskPercent: 1,
  maxDailyLossPercent: 3,
  maxDrawdownPercent: 10,
}).evaluate(context);

if (result.approved && result.order) {
  // Forward only this normalized order to the execution layer.
}
```

## Build

```bash
pnpm --filter @xauusd/risk-engine typecheck
pnpm --filter @xauusd/risk-engine build
pnpm --filter @xauusd/risk-engine test
```

## Safety boundary

This package never sends an order to a broker. It only produces an approval decision and a normalized order candidate. Execution remains the responsibility of the later execution and broker packs.
