# @xauusd/types

Shared, dependency-light contracts for **XAUUSD AI MASTER**.

## Compatibility rule

This pack preserves the existing monorepo structure. `@xauusd/market-data`
continues to own market-specific `Candle`, `Tick`, `SymbolInfo`, and `Timeframe`
types. Generic parameters are used where shared contracts need to reference
market-data objects without creating a circular dependency.

## Build

```bash
pnpm --filter @xauusd/types build
```

## Test

```bash
pnpm --filter @xauusd/types test
```

## Import

```ts
import {
  Signal,
  SwingPoint,
  Trend,
  PriceUtils,
} from "@xauusd/types";
```

## Integration policy

Do not delete existing engine-local models immediately. Migrate one package at
a time, run its TypeScript check and build, then remove duplicate local models
only after all imports have been updated.
