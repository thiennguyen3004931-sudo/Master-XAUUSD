# Local MetaTrader 5 bridge

The official MetaTrader5 Python module connects to a locally installed MT5 terminal. This bridge exposes only the small API required by Pack 08 and binds to `127.0.0.1` by default.

## Safety defaults

- Trading disabled until `MT5_TRADING_ENABLED=true`.
- Real accounts disabled until `MT5_ALLOW_REAL_ACCOUNT=true`.
- Optional account-login allow-list.
- API-key authentication on every route.
- SQLite idempotency ledger for orders and management commands.
- `order_check()` before `order_send()`.
- Canonical-to-broker symbol mapping.
- Automatic read-only IPC recovery after MT5 is closed, restarted or replaced.

The health endpoint retries `MetaTrader5.initialize()` with a short backoff when
the terminal IPC channel disappears. Idempotent reads retry once after recovery;
mutating `order_send()` calls are never retried blindly.

New-order idempotency keys remain reserved once `order_send()` has been entered.
If its response is lost, result decoding fails, or the response cannot be saved
to SQLite, replay of the same key returns `IDEMPOTENCY_IN_PROGRESS` (HTTP 425)
without another send, including after a bridge restart. There is no automatic
expiry or release of this uncertain reservation. Reconcile broker positions,
orders and deal history before deciding how to resolve it; do not evade it by
generating another key. Validation failures before `order_send()` still release
the reservation, and successfully saved responses continue to replay normally.

## Windows setup

1. Install MetaTrader 5 and log in to a demo account.
2. Enable algorithmic trading in MT5.
3. Open PowerShell in this `bridge` folder.
4. Run `./run.ps1` once. It creates `.env` and stops.
5. Edit `.env`, especially the API key, terminal path, account allow-list and symbol map.
6. Keep `MT5_TRADING_ENABLED=false` for the first health and quote tests.
7. Run `./run.ps1` again.
8. Open `http://127.0.0.1:8765/docs` locally for the generated API documentation.

## Demo-first activation

Set the following only after health, quote, symbol-spec and position reads succeed:

```text
MT5_TRADING_ENABLED=true
MT5_ALLOW_REAL_ACCOUNT=false
```

The bridge will still reject real-account orders.
