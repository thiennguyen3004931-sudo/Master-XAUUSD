# @xauusd/mt5-broker

Pack 09 connects `@xauusd/execution-engine` to a locally running MetaTrader 5 terminal through a small authenticated Python bridge.

## Architecture

```text
Strategy Engine
      ↓
Risk Engine
      ↓
Execution Engine
      ↓ IExecutionAdapter
@xauusd/mt5-broker (TypeScript)
      ↓ authenticated localhost HTTP
MT5 Python Bridge (Windows)
      ↓ MetaTrader5 Python package
MetaTrader 5 Terminal
      ↓
Broker trade server
```

## Why a local bridge

The TypeScript package remains transport- and broker-safe, while the Python process uses the official MetaTrader5 integration against a local terminal. Credentials remain in `bridge/.env`, not in the Node application.

## Safety controls

- Localhost binding by default
- API-key authentication
- Trading disabled by default
- Separate opt-in for real accounts
- Account-login allow-list
- Symbol suffix/prefix mapping
- `order_check` before `order_send`
- SQLite idempotency ledger
- Duplicate suppression for entry, close and modify commands
- Exact symbol specification sourced from MT5

## Node setup

```ts
import {
  HttpMt5Transport,
  Mt5BridgeClient,
  Mt5ExecutionAdapter,
  defaultMt5BrokerConfig,
} from "@xauusd/mt5-broker";

const config = {
  ...defaultMt5BrokerConfig,
  bridgeBaseUrl: process.env.MT5_BRIDGE_URL ?? "http://127.0.0.1:8765",
  apiKey: process.env.MT5_BRIDGE_API_KEY ?? "",
};

const adapter = new Mt5ExecutionAdapter(
  new Mt5BridgeClient(new HttpMt5Transport(config), config.healthTimeoutMs),
  config,
);
```

Pass `adapter` to `ExecutionPipeline` from Pack 08.

## Activation order

1. Start with a demo account.
2. Keep `MT5_TRADING_ENABLED=false`.
3. Verify health, quote, symbol specification and open-position reads.
4. Enable trading on demo only.
5. Submit the broker minimum volume with a deliberately small risk budget.
6. Verify ticket, position, partial close, stop modification and reconciliation.
7. Keep real-account trading disabled until the full demo checklist passes.
