# @xauusd/web — Pack 12 Dashboard

Active frontend for XAUUSD AI MASTER.

```text
Vite + React + React Router + MUI + TanStack Query
```

## Run

```powershell
pnpm --filter @xauusd/web dev
```

Default URL:

```text
http://127.0.0.1:5173
```

During development Vite proxies `/api/*` to `http://127.0.0.1:3001`.

## Routes

```text
/
/signals
/risk
/ai
/backtest
/system
/settings
```

The UI has no live-trading enable control.
