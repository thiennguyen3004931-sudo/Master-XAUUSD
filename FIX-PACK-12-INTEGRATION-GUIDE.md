# XAUUSD AI MASTER — FIX PACK 12 INTEGRATION GUIDE

This fix aligns the project with its actual monorepo architecture:

```text
apps/web     Vite + React dashboard
apps/api     Express orchestration API
packages/*   domain engines Packs 01–11
```

The inactive root Next.js overlay has been removed. Pack 12 now lives inside
`apps/web` and its server routes live inside `apps/api`.

## Fixes included

1. Market Data now imports the canonical `TradingSession` from `@xauusd/types`.
2. `signal-engine_backup` has been removed from `packages/*`.
3. `pnpm-lock.yaml` no longer references `_backup` workspaces.
4. `strategy-engine` and `ai-engine` declare test-time `@xauusd/market-data`.
5. Legacy `packages/types/src/candle.ts` and `market.ts` are removed.
6. `packages/mt5-broker/.env` is removed and root `.gitignore` blocks secrets.
7. Pack 12 Dashboard is ported to `apps/web` using the dependencies already in the Vite app.
8. Dashboard/Backtest/System/Control APIs are implemented in `apps/api`.
9. `apps/api` now orchestrates Packs 03–07 and Pack 11 for a real engine snapshot.
10. Backtest UI calls Pack 10 through `apps/api`; synthetic candles are explicitly labelled integration data.

## Important safety boundary

The Dashboard API exposes only `SHADOW` and `DEMO` modes. It does not expose an
endpoint that enables live trading and it does not call Pack 08/09 order placement.

## Install after copying this repository

Because the old lockfile referenced deleted backup workspaces, run:

```powershell
pnpm install
```

The included lockfile has already been repaired, but `pnpm install` should still
be run on your machine to reconstruct workspace links and local `node_modules`.

## Validate

```powershell
node scripts\validate-pack-12.mjs

pnpm --filter @xauusd/types build
pnpm --filter @xauusd/market-data build
pnpm --filter @xauusd/analysis-engine build
pnpm --filter @xauusd/indicators build
pnpm --filter @xauusd/signal-engine build
pnpm --filter @xauusd/risk-engine build
pnpm --filter @xauusd/strategy-engine build
pnpm --filter @xauusd/backtest-engine build
pnpm --filter @xauusd/ai-engine build

pnpm --filter @xauusd/api build
pnpm --filter @xauusd/web build
pnpm -r test
pnpm -r build
```

## Run

Terminal 1:

```powershell
pnpm --filter @xauusd/api dev
```

API default:

```text
http://127.0.0.1:3001
```

Terminal 2:

```powershell
pnpm --filter @xauusd/web dev
```

Dashboard default:

```text
http://127.0.0.1:5173
```

The Vite dev server proxies `/api/*` to the API on port 3001.

## Dashboard routes

```text
/
/signals
/risk
/ai
/backtest
/system
/settings
```

## API routes

```text
GET  /api/v1/health
GET  /api/v1/market/quote
GET  /api/v1/market/candles
GET  /api/v1/dashboard
POST /api/v1/backtest
GET  /api/v1/system/health
GET  /api/v1/control/mode
POST /api/v1/control/mode
```

## MT5 secret action required

The uploaded source archive contained `packages/mt5-broker/.env`. This fix removes
that file, but any API key that appeared there should be rotated before later demo
or live MT5 use. Keep only:

```text
packages/mt5-broker/bridge/.env.example
```

and create your real `.env` locally after rotation.
