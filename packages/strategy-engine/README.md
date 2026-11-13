# @xauusd/strategy-engine

Strategy orchestration for XAUUSD AI MASTER.

Pack 07 consumes the outputs of Analysis, Indicators, Signal and Risk. It selects the strategy that best matches the current market regime and produces a complete trade-management plan. It never sends orders to a broker.

## Built-in strategies

- Trend Continuation
- Breakout Retest
- Liquidity Sweep Reversal
- Range Mean Reversion

## Decision sequence

```text
Analysis + Indicators
        ↓
Signal Engine
        ↓
Risk Engine
        ↓
Market Regime Classification
        ↓
Strategy Candidate Scoring
        ↓
Selection + Safety Rules
        ↓
EXECUTE / WAIT / REJECT
```

## Safety rules

- Accepted directional signal required
- Risk approval and normalized order required
- Upstream context freshness
- Session compatibility
- Minimum regime confidence
- Minimum strategy score
- Minimum score edge over runner-up

## Trade-management output

An executable plan contains:

- approved order candidate
- selected strategy and score breakdown
- partial take-profit targets
- break-even threshold
- ATR trailing-stop policy
- maximum holding time
- pending-order expiry
- hard invalidation price

## Usage

```ts
import { StrategyPipeline } from "@xauusd/strategy-engine";

const evaluation = new StrategyPipeline({
  minimumCandidateScore: 65,
  minimumCandidateEdge: 8,
}).evaluate(context);

if (evaluation.action === "EXECUTE" && evaluation.plan) {
  // Forward the plan to Pack 08 execution-engine.
}
```

## Build

```bash
pnpm --filter @xauusd/strategy-engine typecheck
pnpm --filter @xauusd/strategy-engine build
pnpm --filter @xauusd/strategy-engine test
```

## Production note

The automatic UTC session classifier is intentionally approximate. Supply `context.session` from the market-data or broker layer in production so DST, holidays and broker trading hours are handled correctly.
