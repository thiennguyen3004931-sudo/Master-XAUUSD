# @xauusd/api

Express orchestration layer for the 12-pack integration.

## Run

```powershell
pnpm --filter @xauusd/api dev
```

Default URL:

```text
http://127.0.0.1:3001
```

The dashboard snapshot executes the engine chain over canonical synthetic
XAUUSD candles for integration testing. Pack 08/09 order submission is not called.

Backtest requests are executed by `@xauusd/backtest-engine` using synthetic
historical candles and are labelled as integration results.
