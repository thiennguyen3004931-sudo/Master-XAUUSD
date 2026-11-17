# @xauusd/market-data

Market-data package for XAUUSD AI MASTER. This pack keeps the existing
`packages/market-data` location and the established folder names.

## Public API

- `Candle`, `Tick`, `Symbol`, `SymbolInfo`, `Timeframe`
- `IMarketDataProvider`, `ICandleRepository`
- `BaseMarketDataProvider`, `MockProvider`
- `InMemoryCandleRepository`
- `CandleService`, `MarketDataService`, `SessionService`
- `TradingViewWebhookPayload`, `TradingViewWebhookMapper`

## Build

```bash
pnpm install
pnpm --filter @xauusd/market-data typecheck
pnpm --filter @xauusd/market-data build
pnpm --filter @xauusd/market-data test
```

## Example

```ts
import {
  InMemoryCandleRepository,
  MarketDataService,
  MockProvider,
  Timeframe,
} from "@xauusd/market-data";

const provider = new MockProvider();
const repository = new InMemoryCandleRepository();
const service = new MarketDataService(provider, repository);

await service.connect();
const candles = await service.getCandles("XAUUSD", Timeframe.M15, 200, true);
await service.disconnect();
```

## Compatibility

The pack intentionally preserves market-data ownership of `Candle`, `Tick`,
`Symbol`, and `Timeframe`. Existing imports from `@xauusd/market-data` continue
to work. `@xauusd/types` is used only for the generic shared provider contract.
