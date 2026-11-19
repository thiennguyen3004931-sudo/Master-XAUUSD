from __future__ import annotations

import importlib
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .broker_time import broker_time_offset_ms, denormalize_timestamp_ms
from .config import Settings
from .errors import BridgeError
from .ledger import IdempotencyLedger
from .models import CloseRequest, ModifyRequest, OrderRequest


class Mt5Gateway:
    _RECONNECT_BACKOFF_SECONDS = 2.0
    _HEALTH_LOCK_WAIT_SECONDS = 0.25
    _HEALTH_CACHE_MAX_AGE_SECONDS = 5.0
    _CANDLE_LOCK_WAIT_SECONDS = 0.5

    def __init__(self, settings: Settings, ledger: IdempotencyLedger, module: Any | None = None) -> None:
        self.settings = settings
        self.ledger = ledger
        self.mt5 = module
        self._lock = threading.RLock()
        # Closed-candle snapshots are immutable between bar closes. Keep this
        # cache outside the MT5 gateway lock so repeated M5/M15 reads do not
        # serialize health/positions/quote calls behind copy_rates_from_pos.
        self._closed_candle_cache_lock = threading.Lock()
        self._closed_candle_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._health_snapshot_lock = threading.Lock()
        self._last_health_snapshot: dict[str, Any] | None = None
        self._last_health_snapshot_at = 0.0
        self.last_error: str | None = None
        self.reconnect_count = 0
        self.last_reconnect_at: int | None = None
        self._last_reconnect_attempt = 0.0

    def start(self) -> bool:
        with self._lock:
            if self.mt5 is None:
                try:
                    self.mt5 = importlib.import_module("MetaTrader5")
                except ImportError as exc:
                    self.last_error = "MetaTrader5 package is unavailable. Run the bridge on Windows."
                    return False

            return self._initialize_locked(reconnect=False)

    def stop(self) -> None:
        with self._lock:
            if self.mt5 is not None:
                self.mt5.shutdown()
            self.ledger.close()

    def health(self, reconnect: bool = True) -> dict[str, Any]:
        now = int(time.time() * 1000)
        lock_wait_started = time.monotonic()
        acquired = self._lock.acquire(timeout=self._HEALTH_LOCK_WAIT_SECONDS)
        lock_wait_ms = int((time.monotonic() - lock_wait_started) * 1000)

        if not acquired:
            cached, cache_age_ms = self._recent_health_snapshot()
            if cached is not None:
                return {
                    **cached,
                    "gatewayBusy": True,
                    "healthSource": "RECENT_CACHE",
                    "healthSnapshotAgeMs": cache_age_ms,
                    "healthLockWaitMs": lock_wait_ms,
                    "timestamp": now,
                }

            return {
                "status": "degraded",
                "connected": False,
                "tradingEnabled": self.settings.trading_enabled,
                "terminalTradeAllowed": False,
                "expertTradeAllowed": False,
                "accountLogin": None,
                "accountMode": None,
                "accountBalance": None,
                "accountEquity": None,
                "accountMargin": None,
                "accountFreeMargin": None,
                "accountProfit": None,
                "accountLeverage": None,
                "accountCurrency": None,
                "server": None,
                "terminalVersion": None,
                "lastError": "MT5 gateway is busy; no recent health snapshot is available.",
                "reconnectCount": self.reconnect_count,
                "lastReconnectAt": self.last_reconnect_at,
                "reconnecting": False,
                "gatewayBusy": True,
                "healthSource": "LOCK_BUSY",
                "healthSnapshotAgeMs": None,
                "healthLockWaitMs": lock_wait_ms,
                "timestamp": now,
            }

        try:
            terminal, account = self._connection_snapshot_locked(reconnect=reconnect)
            terminal_version = self._terminal_version()
        finally:
            self._lock.release()

        connected = terminal is not None and account is not None
        mode = self._account_mode(getattr(account, "trade_mode", None)) if account else None
        snapshot = {
            "status": "ok" if connected else "degraded",
            "connected": connected,
            "tradingEnabled": self.settings.trading_enabled,
            "terminalTradeAllowed": bool(getattr(terminal, "trade_allowed", False)),
            "expertTradeAllowed": bool(getattr(account, "trade_expert", False)),
            "accountLogin": int(account.login) if account else None,
            "accountMode": mode,
            "accountBalance": float(getattr(account, "balance", 0.0)) if account else None,
            "accountEquity": float(getattr(account, "equity", 0.0)) if account else None,
            "accountMargin": float(getattr(account, "margin", 0.0)) if account else None,
            "accountFreeMargin": float(getattr(account, "margin_free", 0.0)) if account else None,
            "accountProfit": float(getattr(account, "profit", 0.0)) if account else None,
            "accountLeverage": int(getattr(account, "leverage", 0)) if account else None,
            "accountCurrency": str(getattr(account, "currency", "")) if account else None,
            "server": str(account.server) if account else None,
            "terminalVersion": terminal_version,
            "lastError": self.last_error,
            "reconnectCount": self.reconnect_count,
            "lastReconnectAt": self.last_reconnect_at,
            "reconnecting": not connected,
            "gatewayBusy": False,
            "healthSource": "LIVE_PROBE",
            "healthSnapshotAgeMs": 0,
            "healthLockWaitMs": lock_wait_ms,
            "timestamp": now,
        }
        self._store_health_snapshot(snapshot)
        return snapshot

    def _store_health_snapshot(self, snapshot: dict[str, Any]) -> None:
        with self._health_snapshot_lock:
            self._last_health_snapshot = dict(snapshot)
            self._last_health_snapshot_at = time.monotonic()

    def _recent_health_snapshot(self) -> tuple[dict[str, Any] | None, int | None]:
        with self._health_snapshot_lock:
            if self._last_health_snapshot is None or self._last_health_snapshot_at <= 0:
                return None, None
            age_seconds = max(0.0, time.monotonic() - self._last_health_snapshot_at)
            if age_seconds > self._HEALTH_CACHE_MAX_AGE_SECONDS:
                return None, int(age_seconds * 1000)
            return dict(self._last_health_snapshot), int(age_seconds * 1000)

    def quote(self, canonical_symbol: str) -> dict[str, Any]:
        broker_symbol = self._ensure_symbol(canonical_symbol)
        with self._lock:
            tick = self._read_with_reconnect_locked("symbol_info_tick", broker_symbol)
        if tick is None:
            raise BridgeError(f"No quote for {broker_symbol}", 503, "QUOTE_UNAVAILABLE")
        timestamp = int(getattr(tick, "time_msc", int(tick.time) * 1000))
        bid, ask = float(tick.bid), float(tick.ask)
        return {
            "symbol": canonical_symbol,
            "brokerSymbol": broker_symbol,
            "bid": bid,
            "ask": ask,
            "spread": max(0.0, ask - bid),
            "timestamp": timestamp,
        }

    def trading_day_boundary(
        self,
        canonical_symbol: str,
    ) -> dict[str, Any]:
        # Read-only broker-native risk-day boundary.
        # start_pos=0 intentionally reads the currently forming D1 bar.
        broker_symbol = self._ensure_symbol(canonical_symbol)
        d1 = getattr(self.mt5, "TIMEFRAME_D1", None)

        if d1 is None:
            raise BridgeError(
                "MT5 D1 timeframe unavailable",
                503,
                "D1_TIMEFRAME_UNAVAILABLE",
            )

        with self._lock:
            rows = self._read_with_reconnect_locked(
                "copy_rates_from_pos",
                broker_symbol,
                d1,
                0,
                2,
            )

        if rows is None or len(rows) < 1:
            raise BridgeError(
                f"D1 boundary unavailable: {self.mt5.last_error()}",
                503,
                "TRADING_DAY_BOUNDARY_UNAVAILABLE",
            )

        current = rows[-1]
        previous = rows[-2] if len(rows) >= 2 else None

        current_start = int(current["time"]) * 1000
        previous_start = (
            int(previous["time"]) * 1000
            if previous is not None
            else None
        )

        if current_start <= 0:
            raise BridgeError(
                "Invalid current D1 boundary",
                503,
                "TRADING_DAY_BOUNDARY_INVALID",
            )

        return {
            "symbol": canonical_symbol,
            "brokerSymbol": broker_symbol,
            "currentStartTime": current_start,
            "previousStartTime": previous_start,
            "source": "MT5_D1_CURRENT_BAR",
        }

    def _read_closed_candle_cache(
        self,
        key: tuple[str, str, str],
        count: int,
        now_ms: int,
        duration_ms: int,
        allow_stale: bool = False,
    ) -> list[dict[str, Any]] | None:
        with self._closed_candle_cache_lock:
            cached = self._closed_candle_cache.get(key)
            if cached is None:
                return None
            rows = cached.get("rows")
            if not isinstance(rows, list) or len(rows) < count:
                return None

            refresh_after_ms = int(cached.get("refreshAfterMs", 0) or 0)
            fetched_at_ms = int(cached.get("fetchedAtMs", 0) or 0)
            if allow_stale:
                # Stale-on-busy is deliberately bounded to one timeframe.
                # This keeps the controller fail-closed if market data is old
                # for longer than a single closed-bar interval.
                if fetched_at_ms <= 0 or now_ms - fetched_at_ms > duration_ms:
                    return None
            elif refresh_after_ms <= now_ms:
                return None

            return [dict(row) for row in rows[-count:]]

    def _closed_candle_cached_count(
        self,
        key: tuple[str, str, str],
    ) -> int:
        with self._closed_candle_cache_lock:
            cached = self._closed_candle_cache.get(key)
            rows = cached.get("rows") if cached is not None else None
            return len(rows) if isinstance(rows, list) else 0

    def _store_closed_candle_cache(
        self,
        key: tuple[str, str, str],
        rows: list[dict[str, Any]],
        refresh_after_ms: int,
        fetched_at_ms: int,
    ) -> None:
        with self._closed_candle_cache_lock:
            self._closed_candle_cache[key] = {
                "rows": [dict(row) for row in rows],
                "refreshAfterMs": int(refresh_after_ms),
                "fetchedAtMs": int(fetched_at_ms),
            }

    def _clear_closed_candle_cache(self) -> None:
        with self._closed_candle_cache_lock:
            self._closed_candle_cache.clear()

    def candles(self, canonical_symbol: str, timeframe: str = "M15", count: int = 320) -> list[dict[str, Any]]:
        """Return fully closed MT5 candles without repeatedly loading unchanged history.

        The endpoint excludes the still-forming bar (start_pos=1), so the
        returned series is immutable until the next timeframe close. Cache
        hits bypass the shared MT5 lock. When a refresh is due but another MT5
        operation currently owns the lock, a recent cached series (at most one
        timeframe old) is returned instead of queueing another heavyweight
        copy_rates_from_pos call behind position-management traffic.
        """
        # Resolve the configured broker symbol without touching MT5. A fresh
        # cache hit must remain independent of the shared gateway lock.
        broker_symbol = self.settings.broker_symbol(canonical_symbol)
        timeframe_key = str(timeframe).strip().upper()

        timeframe_map = {
            "M1": getattr(self.mt5, "TIMEFRAME_M1", None),
            "M5": getattr(self.mt5, "TIMEFRAME_M5", None),
            "M15": getattr(self.mt5, "TIMEFRAME_M15", None),
            "M30": getattr(self.mt5, "TIMEFRAME_M30", None),
            "H1": getattr(self.mt5, "TIMEFRAME_H1", None),
            "H4": getattr(self.mt5, "TIMEFRAME_H4", None),
            "D1": getattr(self.mt5, "TIMEFRAME_D1", None),
        }
        duration_ms = {
            "M1": 60_000,
            "M5": 5 * 60_000,
            "M15": 15 * 60_000,
            "M30": 30 * 60_000,
            "H1": 60 * 60_000,
            "H4": 4 * 60 * 60_000,
            "D1": 24 * 60 * 60_000,
        }

        mt5_timeframe = timeframe_map.get(timeframe_key)
        if mt5_timeframe is None:
            raise BridgeError(
                f"Unsupported timeframe {timeframe}",
                400,
                "TIMEFRAME_UNSUPPORTED",
            )

        try:
            safe_count = int(count)
        except (TypeError, ValueError):
            raise BridgeError("Invalid candle count", 400, "CANDLE_COUNT_INVALID")

        if safe_count < 2 or safe_count > 5000:
            raise BridgeError(
                "Candle count must be between 2 and 5000",
                400,
                "CANDLE_COUNT_INVALID",
            )

        candle_duration_ms = duration_ms[timeframe_key]
        cache_key = (canonical_symbol, broker_symbol, timeframe_key)
        now_ms = int(time.time() * 1000)

        fresh = self._read_closed_candle_cache(
            cache_key,
            safe_count,
            now_ms,
            candle_duration_ms,
        )
        if fresh is not None:
            return fresh

        stale = self._read_closed_candle_cache(
            cache_key,
            safe_count,
            now_ms,
            candle_duration_ms,
            allow_stale=True,
        )
        cached_count = self._closed_candle_cached_count(cache_key)
        fetch_count = max(safe_count, cached_count)
        cached_refresh_base = (
            self._read_closed_candle_cache(
                cache_key,
                cached_count,
                now_ms,
                candle_duration_ms,
                allow_stale=True,
            )
            if cached_count > 0
            else None
        )
        # A recent cache can be advanced with a small tail read. Because the
        # stale reuse window is at most one timeframe, eight bars is safely
        # more than the number of newly closed bars that can be missing.
        mt5_fetch_count = min(fetch_count, 8) if cached_refresh_base is not None else fetch_count

        # Do not let a candle refresh sit behind a critical MT5 operation
        # until the HTTP client timeout. A recent closed-bar snapshot is served
        # immediately; without one, wait only a short bounded interval and
        # return an explicit transient 503 that callers may retry safely.
        if stale is not None:
            acquired = self._lock.acquire(blocking=False)
            if not acquired:
                return stale
        else:
            acquired = self._lock.acquire(timeout=self._CANDLE_LOCK_WAIT_SECONDS)
            if not acquired:
                raise BridgeError(
                    "MT5 gateway is busy; closed-candle refresh was not started.",
                    503,
                    "CANDLES_GATEWAY_BUSY",
                )

        try:
            # Another request may have refreshed the cache before this thread
            # acquired the MT5 lock.
            now_ms = int(time.time() * 1000)
            fresh = self._read_closed_candle_cache(
                cache_key,
                safe_count,
                now_ms,
                candle_duration_ms,
            )
            if fresh is not None:
                return fresh

            info = self._read_with_reconnect_locked("symbol_info", broker_symbol)
            if info is None:
                raise BridgeError(
                    f"No symbol specification for {broker_symbol}",
                    404,
                    "SYMBOL_NOT_FOUND",
                )
            if not bool(getattr(info, "visible", False)) and not self.mt5.symbol_select(broker_symbol, True):
                raise BridgeError(
                    f"Could not select {broker_symbol} in MarketWatch",
                    503,
                    "SYMBOL_SELECT_FAILED",
                )

            # start_pos=1 intentionally excludes the still-forming current candle.
            rows = self._read_with_reconnect_locked(
                "copy_rates_from_pos",
                broker_symbol,
                mt5_timeframe,
                1,
                mt5_fetch_count,
            )
        finally:
            self._lock.release()

        if rows is None:
            raise BridgeError(
                f"copy_rates_from_pos failed: {self.mt5.last_error()}",
                503,
                "CANDLES_UNAVAILABLE",
            )

        point = float(getattr(info, "point", 0.0) or 0.0)
        refreshed_output: list[dict[str, Any]] = []

        for row in rows:
            try:
                spread_points = float(row["spread"])
            except Exception:
                spread_points = 0.0

            open_time = int(row["time"]) * 1000
            refreshed_output.append(
                {
                    "symbol": canonical_symbol,
                    "brokerSymbol": broker_symbol,
                    "timeframe": timeframe_key,
                    "openTime": open_time,
                    "closeTime": open_time + candle_duration_ms,
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": float(row["tick_volume"]),
                    "spread": max(0.0, spread_points * point),
                }
            )

        if cached_refresh_base is not None:
            merged_by_open_time = {
                int(row["openTime"]): dict(row)
                for row in cached_refresh_base
            }
            for row in refreshed_output:
                merged_by_open_time[int(row["openTime"])] = dict(row)
            output = sorted(
                merged_by_open_time.values(),
                key=lambda row: int(row["openTime"]),
            )[-fetch_count:]
        else:
            output = refreshed_output[-fetch_count:]

        fetched_at_ms = int(time.time() * 1000)
        refresh_after_ms = fetched_at_ms + min(5_000, candle_duration_ms)
        if output:
            latest_close_utc_ms = int(output[-1]["closeTime"]) - broker_time_offset_ms()
            next_close_utc_ms = latest_close_utc_ms + candle_duration_ms
            if next_close_utc_ms > fetched_at_ms:
                # Add a small grace so MT5 has time to publish the just-closed
                # candle before the next heavyweight history refresh.
                refresh_after_ms = next_close_utc_ms + 1_000

        self._store_closed_candle_cache(
            cache_key,
            output,
            refresh_after_ms,
            fetched_at_ms,
        )
        return [dict(row) for row in output[-safe_count:]]

    def symbol_spec(self, canonical_symbol: str) -> dict[str, Any]:
        broker_symbol = self._ensure_symbol(canonical_symbol)
        with self._lock:
            info = self._read_with_reconnect_locked("symbol_info", broker_symbol)
        if info is None:
            raise BridgeError(f"No symbol specification for {broker_symbol}", 404, "SYMBOL_NOT_FOUND")
        tick_size = float(getattr(info, "trade_tick_size", 0.0) or getattr(info, "point", 0.0))
        point = float(getattr(info, "point", tick_size))
        max_points = self.settings.max_spread_points.get(canonical_symbol, 50.0)
        effective_tick_value_per_lot, cash_per_price_unit_per_lot = self._effective_tick_value_per_lot(
            broker_symbol,
            float(getattr(info, "trade_tick_size", 0.0) or 0.0),
        )

        return {
            "symbol": canonical_symbol,
            "brokerSymbol": broker_symbol,
            "tickSize": tick_size,
            "point": point,
            "tickValuePerLot": float(getattr(info, "trade_tick_value", 0.0) or 0.0),
            "effectiveTickValuePerLot": effective_tick_value_per_lot,
            "cashPerPriceUnitPerLot": cash_per_price_unit_per_lot,
            "riskValueSource": "MT5_ORDER_CALC_PROFIT",
            "tickValueProfitPerLot": float(getattr(info, "trade_tick_value_profit", 0.0) or 0.0),
            "tickValueLossPerLot": float(getattr(info, "trade_tick_value_loss", 0.0) or 0.0),
            "contractSize": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
            "digits": int(info.digits),
            "minVolume": float(info.volume_min),
            "maxVolume": float(info.volume_max),
            "volumeStep": float(info.volume_step),
            "maxSpread": float(max_points) * point,
            "stopsLevelTicks": int(getattr(info, "trade_stops_level", 0)),
            "freezeLevelTicks": int(getattr(info, "trade_freeze_level", 0)),
            "fillingMode": int(getattr(info, "filling_mode", 0)),
            "executionMode": int(getattr(info, "trade_exemode", 0)),
        }

    def deals(
        self,
        from_ms: int,
        to_ms: int,
        canonical_symbol: str | None = None,
    ) -> list[dict[str, Any]]:
        # Read-only MT5 deal history. This method never requires trading.
        try:
            start_ms = int(from_ms)
            end_ms = int(to_ms)
        except (TypeError, ValueError):
            raise BridgeError("Invalid deal history range", 400, "DEAL_RANGE_INVALID")

        if start_ms < 0 or end_ms <= start_ms:
            raise BridgeError("Invalid deal history range", 400, "DEAL_RANGE_INVALID")

        max_range_ms = 15 * 365 * 24 * 60 * 60 * 1000
        if end_ms - start_ms > max_range_ms:
            raise BridgeError(
                "Deal history range exceeds 15 years",
                400,
                "DEAL_RANGE_TOO_LARGE",
            )

        broker_symbol = (
            self.settings.broker_symbol(canonical_symbol)
            if canonical_symbol
            else None
        )

        broker_start_ms = denormalize_timestamp_ms(start_ms)
        broker_end_ms = denormalize_timestamp_ms(end_ms)
        start = datetime.fromtimestamp(broker_start_ms / 1000.0, tz=timezone.utc)
        end = datetime.fromtimestamp(broker_end_ms / 1000.0, tz=timezone.utc)

        with self._lock:
            rows = self._read_with_reconnect_locked("history_deals_get", start, end)

        if rows is None:
            raise BridgeError(
                f"history_deals_get failed: {self.mt5.last_error()}",
                503,
                "DEAL_HISTORY_UNAVAILABLE",
            )

        deal_type_buy = int(getattr(self.mt5, "DEAL_TYPE_BUY", 0))
        deal_type_sell = int(getattr(self.mt5, "DEAL_TYPE_SELL", 1))
        entry_names = {
            int(getattr(self.mt5, "DEAL_ENTRY_IN", 0)): "IN",
            int(getattr(self.mt5, "DEAL_ENTRY_OUT", 1)): "OUT",
            int(getattr(self.mt5, "DEAL_ENTRY_INOUT", 2)): "INOUT",
            int(getattr(self.mt5, "DEAL_ENTRY_OUT_BY", 3)): "OUT_BY",
        }

        output: list[dict[str, Any]] = []

        for row in rows:
            row_symbol = str(getattr(row, "symbol", "") or "")
            if broker_symbol and row_symbol != broker_symbol:
                continue

            deal_type = int(getattr(row, "type", -1))
            side = (
                "BUY"
                if deal_type == deal_type_buy
                else "SELL"
                if deal_type == deal_type_sell
                else None
            )
            is_trading = side is not None

            profit = float(getattr(row, "profit", 0.0) or 0.0)
            commission = float(getattr(row, "commission", 0.0) or 0.0)
            swap = float(getattr(row, "swap", 0.0) or 0.0)
            fee = float(getattr(row, "fee", 0.0) or 0.0)

            time_msc = int(
                getattr(
                    row,
                    "time_msc",
                    int(getattr(row, "time", 0)) * 1000,
                )
            )

            output.append(
                {
                    "ticket": str(getattr(row, "ticket", "")),
                    "orderId": str(getattr(row, "order", "")),
                    "positionId": str(getattr(row, "position_id", "")),
                    "symbol": self.settings.canonical_symbol(row_symbol),
                    "side": side,
                    "entry": entry_names.get(
                        int(getattr(row, "entry", -1)),
                        "UNKNOWN",
                    ),
                    "volume": float(getattr(row, "volume", 0.0) or 0.0),
                    "price": float(getattr(row, "price", 0.0) or 0.0),
                    "profit": profit,
                    "commission": commission,
                    "swap": swap,
                    "fee": fee,
                    "netPnl": profit + commission + swap + fee,
                    "magic": int(getattr(row, "magic", 0) or 0),
                    "comment": str(getattr(row, "comment", "") or ""),
                    "timestamp": time_msc,
                    "isTradingDeal": is_trading,
                }
            )

        output.sort(key=lambda deal: int(deal["timestamp"]))
        return output

    def positions(
        self,
        canonical_symbol: str | None = None,
        reconnect: bool = True,
    ) -> list[dict[str, Any]]:
        broker_symbol = self.settings.broker_symbol(canonical_symbol) if canonical_symbol else None
        with self._lock:
            rows = (
                self._read_with_reconnect_locked(
                    "positions_get",
                    symbol=broker_symbol,
                    reconnect=reconnect,
                )
                if broker_symbol
                else self._read_with_reconnect_locked("positions_get", reconnect=reconnect)
            )
        if rows is None:
            raise BridgeError(f"positions_get failed: {self.mt5.last_error()}", 503, "POSITIONS_UNAVAILABLE")
        return [self._position_dict(row) for row in rows]

    def place_order(self, request: OrderRequest) -> dict[str, Any]:
        key = f"order:{request.idempotencyKey}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        send_started = False
        try:
            self._require_trading()
            broker_symbol = self._ensure_symbol(request.symbol)
            with self._lock:
                info = self.mt5.symbol_info(broker_symbol)
                tick = self.mt5.symbol_info_tick(broker_symbol)
                if info is None or tick is None:
                    raise BridgeError("Symbol information or quote is unavailable", 503)

                # Defense in depth: enforce spread at the bridge boundary as well.
                # This prevents callers from bypassing an upstream execution/risk guard
                # by posting directly to /v1/orders.
                self._enforce_spread(request.symbol, info, tick)

                mt5_request = self._build_order_request(request, broker_symbol, info, tick)
                check = self.mt5.order_check(mt5_request)
                if check is None:
                    raise BridgeError(f"order_check failed: {self.mt5.last_error()}", 400, "ORDER_CHECK_FAILED")
                check_code = int(getattr(check, "retcode", -1))
                accepted_check_codes = {0, int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009)), int(getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008))}
                if check_code not in accepted_check_codes:
                    response = self._rejected_response(check_code, str(getattr(check, "comment", "order_check rejected")))
                    self.ledger.complete(key, response)
                    return response
                # From this point a missing response or ledger-write failure
                # cannot prove that the broker rejected the order. Keep the
                # durable reservation so a retry cannot send it a second time.
                send_started = True
                result = self.mt5.order_send(mt5_request)
            if result is None:
                raise BridgeError(f"order_send failed: {self.mt5.last_error()}", 502, "ORDER_SEND_FAILED")
            response = self._order_result(request, broker_symbol, result)
            self.ledger.complete(key, response)
            return response
        except Exception:
            if not send_started:
                self.ledger.release(key)
            raise

    def cancel_order(self, ticket: str) -> dict[str, Any]:
        key = f"cancel:{ticket}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        try:
            self._require_trading()
            with self._lock:
                result = self.mt5.order_send({"action": self.mt5.TRADE_ACTION_REMOVE, "order": int(ticket)})
            response = self._command_from_result("", result, "Order cancelled")
            response.pop("commandId", None)
            self.ledger.complete(key, response)
            return response
        except Exception:
            self.ledger.release(key)
            raise

    def close_position(self, ticket: str, request: CloseRequest) -> dict[str, Any]:
        key = f"command:{request.commandId}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        try:
            self._require_trading()
            with self._lock:
                positions = self.mt5.positions_get(ticket=int(ticket))
                if not positions:
                    raise BridgeError(f"Position {ticket} was not found", 404, "POSITION_NOT_FOUND")
                position = positions[0]
                info = self.mt5.symbol_info(position.symbol)
                tick = self.mt5.symbol_info_tick(position.symbol)
                if info is None or tick is None:
                    raise BridgeError("Position symbol data is unavailable", 503)
                position_is_buy = int(position.type) == int(getattr(self.mt5, "POSITION_TYPE_BUY", 0))
                close_type = self.mt5.ORDER_TYPE_SELL if position_is_buy else self.mt5.ORDER_TYPE_BUY
                price = float(tick.bid if position_is_buy else tick.ask)
                volume = min(float(request.volume), float(position.volume))
                payload = {
                    "action": self.mt5.TRADE_ACTION_DEAL,
                    "symbol": position.symbol,
                    "position": int(position.ticket),
                    "volume": volume,
                    "type": close_type,
                    "price": price,
                    "deviation": self.settings.deviation_points,
                    "magic": self.settings.magic_number,
                    "comment": self._comment(request.commandId),
                    "type_time": self.mt5.ORDER_TIME_GTC,
                    "type_filling": self._resolve_filling(info, "IOC", pending=False),
                }
                result = self.mt5.order_send(payload)
            response = self._command_from_result(request.commandId, result, f"Closed {volume} lots from {ticket}")
            self.ledger.complete(key, response)
            return response
        except Exception:
            self.ledger.release(key)
            raise

    def modify_position(self, ticket: str, request: ModifyRequest) -> dict[str, Any]:
        key = f"command:{request.commandId}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        try:
            self._require_trading()
            with self._lock:
                positions = self.mt5.positions_get(ticket=int(ticket))
                if not positions:
                    raise BridgeError(f"Position {ticket} was not found", 404, "POSITION_NOT_FOUND")
                position = positions[0]
                payload = {
                    "action": self.mt5.TRADE_ACTION_SLTP,
                    "symbol": position.symbol,
                    "position": int(position.ticket),
                    # PATCH semantics are partial. Preserve the broker's live
                    # protection value for any field the caller omitted so a
                    # TP-only reconcile cannot roll back a newer BE/FastMove/M5 SL.
                    "sl": float(request.stopLoss if request.stopLoss is not None else position.sl),
                    "tp": float(request.takeProfit if request.takeProfit is not None else position.tp),
                    "magic": self.settings.magic_number,
                    "comment": self._comment(request.commandId),
                }
                result = self.mt5.order_send(payload)
            response = self._command_from_result(request.commandId, result, f"Modified protection for {ticket}")
            self.ledger.complete(key, response)
            return response
        except Exception:
            self.ledger.release(key)
            raise

    def _reserve_or_replay(self, key: str) -> dict[str, Any] | None:
        state, replay = self.ledger.reserve(key)
        if state == "COMPLETED" and replay is not None:
            return {**replay, "idempotentReplay": True}
        if state == "PENDING":
            raise BridgeError("An identical MT5 request is still in progress", 425, "IDEMPOTENCY_IN_PROGRESS")
        return None

    def _require_trading(self) -> None:
        if not self.settings.trading_enabled:
            raise BridgeError("MT5 bridge trading is disabled", 423, "TRADING_DISABLED")
        with self._lock:
            terminal, account = self._connection_snapshot_locked(reconnect=True)
        if account is None or terminal is None:
            raise BridgeError("MT5 terminal is disconnected", 503, "TERMINAL_DISCONNECTED")
        if self.settings.allowed_logins and int(account.login) not in self.settings.allowed_logins:
            raise BridgeError("Current account login is not allow-listed", 403, "ACCOUNT_NOT_ALLOWED")
        if self._account_mode(int(account.trade_mode)) == "real" and not self.settings.allow_real_account:
            raise BridgeError("Real-account trading requires MT5_ALLOW_REAL_ACCOUNT=true", 423, "REAL_ACCOUNT_DISABLED")
        if not bool(getattr(account, "trade_allowed", False)) or not bool(getattr(account, "trade_expert", False)):
            raise BridgeError("Account does not permit automated trading", 423, "AUTOTRADING_DISABLED")
        if not bool(getattr(terminal, "trade_allowed", False)):
            raise BridgeError("Terminal does not permit trading", 423, "TERMINAL_TRADING_DISABLED")

    def _ensure_symbol(self, canonical: str) -> str:
        broker = self.settings.broker_symbol(canonical)
        with self._lock:
            info = self._read_with_reconnect_locked("symbol_info", broker)
            if info is None:
                raise BridgeError(f"Broker symbol {broker} was not found", 404, "SYMBOL_NOT_FOUND")
            if not bool(getattr(info, "visible", False)) and not self.mt5.symbol_select(broker, True):
                raise BridgeError(f"Could not select {broker} in MarketWatch", 503, "SYMBOL_SELECT_FAILED")
        return broker

    def _initialize_kwargs(self, reconnect: bool) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            # Initial service startup may wait for MT5, but a health/read
            # recovery must return before the local API health timeout. Short
            # attempts repeat with backoff until the reopened terminal is ready.
            "timeout": min(self.settings.initialize_timeout_ms, 1_000)
            if reconnect
            else self.settings.initialize_timeout_ms,
            "portable": self.settings.portable,
        }
        import os
        if self.settings.terminal_path and os.path.exists(self.settings.terminal_path):
            kwargs["path"] = self.settings.terminal_path
        if self.settings.password:
            if self.settings.login is not None:
                kwargs["login"] = self.settings.login
            kwargs["password"] = self.settings.password
            if self.settings.server:
                kwargs["server"] = self.settings.server
        return kwargs

    def _initialize_locked(self, reconnect: bool) -> bool:
        if self.mt5 is None:
            self.last_error = "MetaTrader5 package is unavailable. Run the bridge on Windows."
            return False
        if reconnect:
            try:
                self.mt5.shutdown()
            except Exception:
                # A broken IPC channel may also make shutdown fail. initialize()
                # remains the authoritative recovery operation.
                pass
        try:
            initialized = bool(self.mt5.initialize(**self._initialize_kwargs(reconnect)))
        except Exception as exc:
            self.last_error = f"initialize raised: {exc}"
            return False
        if not initialized:
            self.last_error = f"initialize failed: {self._last_mt5_error_locked()}"
            return False
        self.last_error = None
        # A fresh MT5 IPC generation must not inherit closed-bar snapshots
        # from the previous terminal connection.
        self._clear_closed_candle_cache()
        if reconnect:
            self.reconnect_count += 1
            self.last_reconnect_at = int(time.time() * 1000)
        return True

    def _last_mt5_error_locked(self) -> Any:
        try:
            return self.mt5.last_error() if self.mt5 is not None else None
        except Exception as exc:
            return (None, str(exc))

    @staticmethod
    def _is_recoverable_connection_error(error: Any) -> bool:
        code = None
        message = str(error).lower()
        if isinstance(error, (tuple, list)) and error:
            try:
                code = int(error[0])
            except (TypeError, ValueError):
                code = None
        return bool(
            (code is not None and -10100 < code <= -10000)
            or "ipc" in message
            or "not initialized" in message
            or "terminal closed" in message
            or "connection failed" in message
        )

    def _reconnect_locked(self, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and now - self._last_reconnect_attempt < self._RECONNECT_BACKOFF_SECONDS:
            return False
        self._last_reconnect_attempt = now
        return self._initialize_locked(reconnect=True)

    def _connection_snapshot_locked(self, reconnect: bool) -> tuple[Any | None, Any | None]:
        if self.mt5 is None:
            return None, None
        try:
            terminal = self.mt5.terminal_info()
            account = self.mt5.account_info()
        except Exception as exc:
            terminal = None
            account = None
            self.last_error = f"MT5 connection probe failed: {exc}"
        if terminal is not None and account is not None:
            self.last_error = None
            return terminal, account

        error = self._last_mt5_error_locked()
        self.last_error = f"MT5 terminal disconnected: {error}"
        if reconnect and self._reconnect_locked():
            try:
                terminal = self.mt5.terminal_info()
                account = self.mt5.account_info()
            except Exception as exc:
                self.last_error = f"MT5 reconnect probe failed: {exc}"
                return None, None
            if terminal is not None and account is not None:
                self.last_error = None
                return terminal, account
            self.last_error = f"MT5 reconnect incomplete: {self._last_mt5_error_locked()}"
        return None, None

    def _ensure_connected_locked(self) -> None:
        terminal, account = self._connection_snapshot_locked(reconnect=True)
        if terminal is None or account is None:
            raise BridgeError(
                self.last_error or "MT5 terminal is disconnected",
                503,
                "TERMINAL_DISCONNECTED",
            )

    def _read_with_reconnect_locked(
        self,
        method_name: str,
        *args: Any,
        reconnect: bool = True,
        **kwargs: Any,
    ) -> Any:
        """Run an idempotent MT5 read and optionally retry after an IPC reconnect.

        This helper is deliberately not used for order_send. A lost response to
        a mutating request must never be retried blindly because the broker may
        already have accepted the original command. Setting reconnect=False is
        reserved for strict observation-only callers.
        """
        if reconnect:
            self._ensure_connected_locked()
        elif self.mt5 is None:
            return None
        method = getattr(self.mt5, method_name)
        result = method(*args, **kwargs)
        if result is not None or not reconnect:
            return result
        error = self._last_mt5_error_locked()
        if not self._is_recoverable_connection_error(error):
            return None
        self.last_error = f"{method_name} lost MT5 IPC: {error}"
        if not self._reconnect_locked(force=True):
            return None
        return getattr(self.mt5, method_name)(*args, **kwargs)

    def _enforce_spread(self, canonical_symbol: str, info: Any, tick: Any) -> None:
        point = float(getattr(info, "point", 0.0) or 0.0)
        if point <= 0:
            raise BridgeError(
                "Symbol point size is unavailable; spread cannot be validated",
                503,
                "SYMBOL_POINT_UNAVAILABLE",
            )

        bid = float(getattr(tick, "bid", 0.0) or 0.0)
        ask = float(getattr(tick, "ask", 0.0) or 0.0)
        if bid <= 0 or ask <= 0 or ask < bid:
            raise BridgeError(
                "Invalid quote; spread cannot be validated",
                503,
                "INVALID_QUOTE",
            )

        spread_points = (ask - bid) / point
        max_points = float(self.settings.max_spread_points.get(canonical_symbol, 50.0))

        if max_points <= 0:
            raise BridgeError(
                f"Invalid max-spread configuration for {canonical_symbol}",
                500,
                "INVALID_SPREAD_CONFIG",
            )

        # Small epsilon avoids false rejects caused only by binary floating-point noise
        # at an exact threshold such as 0.65 / 0.01.
        if spread_points > max_points + 1e-9:
            raise BridgeError(
                (
                    f"Spread too wide for {canonical_symbol}: "
                    f"{spread_points:.1f} points > {max_points:.1f} points"
                ),
                409,
                "SPREAD_TOO_WIDE",
            )

    def _build_order_request(self, request: OrderRequest, symbol: str, info: Any, tick: Any) -> dict[str, Any]:
        is_buy = request.side == "BUY"
        pending = request.orderType != "MARKET"
        if request.orderType == "MARKET":
            order_type = self.mt5.ORDER_TYPE_BUY if is_buy else self.mt5.ORDER_TYPE_SELL
            action = self.mt5.TRADE_ACTION_DEAL
            price = float(tick.ask if is_buy else tick.bid)
        elif request.orderType == "LIMIT":
            order_type = self.mt5.ORDER_TYPE_BUY_LIMIT if is_buy else self.mt5.ORDER_TYPE_SELL_LIMIT
            action = self.mt5.TRADE_ACTION_PENDING
            price = request.requestedPrice
        else:
            order_type = self.mt5.ORDER_TYPE_BUY_STOP if is_buy else self.mt5.ORDER_TYPE_SELL_STOP
            action = self.mt5.TRADE_ACTION_PENDING
            price = request.requestedPrice

        payload: dict[str, Any] = {
            "action": action,
            "symbol": symbol,
            "volume": request.volume,
            "type": order_type,
            "price": price,
            "sl": request.stopLoss,
            "tp": request.takeProfit,
            "deviation": request.deviationPoints,
            "magic": request.magicNumber,
            "comment": self._comment(request.clientOrderId),
            "type_filling": self._resolve_filling(info, request.timeInForce, pending),
            "type_time": self._resolve_time(request.timeInForce, request.expiresAt, pending),
        }
        if pending and request.expiresAt is not None:
            payload["expiration"] = int(request.expiresAt / 1000)
        return payload

    def _resolve_filling(self, info: Any, tif: str, pending: bool) -> int:
        if pending:
            return int(self.mt5.ORDER_FILLING_RETURN)
        if tif == "FOK":
            return int(self.mt5.ORDER_FILLING_FOK)
        if tif == "IOC":
            return int(self.mt5.ORDER_FILLING_IOC)
        mode = int(getattr(info, "filling_mode", 0))
        ioc_flag = int(getattr(self.mt5, "SYMBOL_FILLING_IOC", 2))
        fok_flag = int(getattr(self.mt5, "SYMBOL_FILLING_FOK", 1))
        if mode & ioc_flag:
            return int(self.mt5.ORDER_FILLING_IOC)
        if mode & fok_flag:
            return int(self.mt5.ORDER_FILLING_FOK)
        market_execution = int(getattr(self.mt5, "SYMBOL_TRADE_EXECUTION_MARKET", 2))
        if int(getattr(info, "trade_exemode", -1)) == market_execution:
            raise BridgeError("No supported FOK/IOC filling mode for Market Execution symbol", 400, "FILLING_MODE_UNSUPPORTED")
        return int(self.mt5.ORDER_FILLING_RETURN)

    def _resolve_time(self, tif: str, expires_at: int | None, pending: bool) -> int:
        if pending and expires_at is not None:
            return int(self.mt5.ORDER_TIME_SPECIFIED)
        if tif == "DAY":
            return int(self.mt5.ORDER_TIME_DAY)
        return int(self.mt5.ORDER_TIME_GTC)

    def _order_result(self, request: OrderRequest, broker_symbol: str, result: Any) -> dict[str, Any]:
        code = int(getattr(result, "retcode", -1))
        done = int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009))
        partial = int(getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010))
        placed = int(getattr(self.mt5, "TRADE_RETCODE_PLACED", 10008))
        accepted = code in {done, partial, placed}
        status = "FILLED" if code == done else "PARTIALLY_FILLED" if code == partial else "SUBMITTING" if code == placed else "REJECTED"
        position = self._find_opened_position(request, broker_symbol) if accepted else None
        return {
            "accepted": accepted,
            "status": status,
            "brokerOrderId": str(getattr(result, "order", "")) or None,
            "ticket": position["ticket"] if position else (str(getattr(result, "order", "")) or None),
            "position": position,
            "fillPrice": float(getattr(result, "price", 0.0)) or None,
            "filledVolume": float(getattr(result, "volume", 0.0)) or None,
            "message": str(getattr(result, "comment", "")) or ("accepted" if accepted else "rejected"),
            "retcode": code,
            "brokerTimestamp": int(time.time() * 1000),
            "idempotentReplay": False,
        }

    def _rejected_response(self, retcode: int, message: str) -> dict[str, Any]:
        return {
            "accepted": False,
            "status": "REJECTED",
            "message": message,
            "retcode": retcode,
            "brokerTimestamp": int(time.time() * 1000),
            "idempotentReplay": False,
        }

    def _command_from_result(self, command_id: str, result: Any, success_message: str) -> dict[str, Any]:
        if result is None:
            return {
                "commandId": command_id,
                "success": False,
                "message": f"order_send returned None: {self.mt5.last_error()}",
                "executedAt": int(time.time() * 1000),
                "idempotentReplay": False,
            }
        code = int(getattr(result, "retcode", -1))
        success_codes = {
            int(getattr(self.mt5, "TRADE_RETCODE_DONE", 10009)),
            int(getattr(self.mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010)),
            int(getattr(self.mt5, "TRADE_RETCODE_NO_CHANGES", 10025)),
        }
        success = code in success_codes
        return {
            "commandId": command_id,
            "success": success,
            "message": success_message if success else str(getattr(result, "comment", "request rejected")),
            "retcode": code,
            "executedAt": int(time.time() * 1000),
            "idempotentReplay": False,
        }

    def _find_opened_position(self, request: OrderRequest, broker_symbol: str) -> dict[str, Any] | None:
        rows = self.mt5.positions_get(symbol=broker_symbol)
        if not rows:
            return None
        is_buy = request.side == "BUY"
        expected_type = int(getattr(self.mt5, "POSITION_TYPE_BUY", 0) if is_buy else getattr(self.mt5, "POSITION_TYPE_SELL", 1))
        expected_magic = int(request.magicNumber)
        expected_comment = self._comment(request.clientOrderId)
        candidates = [
            row
            for row in rows
            if int(row.type) == expected_type
            and int(getattr(row, "magic", 0) or 0) == expected_magic
            and str(getattr(row, "comment", "") or "") == expected_comment
        ]
        if not candidates:
            return None
        newest = max(candidates, key=lambda row: int(getattr(row, "time_msc", int(row.time) * 1000)))
        return self._position_dict(newest)

    def _effective_tick_value_per_lot(
        self,
        broker_symbol: str,
        tick_size: float,
    ) -> tuple[float, float]:
        # Read-only broker cash-risk calibration.
        # order_calc_profit performs no order_check and no order_send.
        if tick_size <= 0:
            raise BridgeError(
                "Invalid broker tick size for cash-risk calibration",
                503,
                "RISK_TICK_SIZE_INVALID",
            )

        with self._lock:
            tick = self._read_with_reconnect_locked("symbol_info_tick", broker_symbol)
        if tick is None:
            raise BridgeError(
                f"symbol_info_tick failed: {self.mt5.last_error()}",
                503,
                "RISK_TICK_UNAVAILABLE",
            )

        ask = float(getattr(tick, "ask", 0.0) or 0.0)
        bid = float(getattr(tick, "bid", 0.0) or 0.0)

        if ask <= 0 or bid <= 0:
            raise BridgeError(
                "Invalid quote for cash-risk calibration",
                503,
                "RISK_QUOTE_INVALID",
            )

        with self._lock:
            buy_value = self._read_with_reconnect_locked(
                "order_calc_profit",
                getattr(self.mt5, "ORDER_TYPE_BUY", 0),
                broker_symbol,
                1.0,
                ask,
                ask - tick_size,
            )
            sell_value = self._read_with_reconnect_locked(
                "order_calc_profit",
                getattr(self.mt5, "ORDER_TYPE_SELL", 1),
                broker_symbol,
                1.0,
                bid,
                bid + tick_size,
            )

        if buy_value is None or sell_value is None:
            raise BridgeError(
                f"order_calc_profit failed: {self.mt5.last_error()}",
                503,
                "RISK_VALUE_CALC_UNAVAILABLE",
            )

        effective = (
            abs(float(buy_value)) + abs(float(sell_value))
        ) / 2.0

        if not (effective > 0):
            raise BridgeError(
                "Effective broker tick value is invalid",
                503,
                "RISK_VALUE_INVALID",
            )

        return effective, effective / tick_size

    def _position_dict(self, row: Any) -> dict[str, Any]:
        broker_symbol = str(row.symbol)
        is_buy = int(row.type) == int(getattr(self.mt5, "POSITION_TYPE_BUY", 0))
        return {
            "ticket": str(row.ticket),
            "symbol": self.settings.canonical_symbol(broker_symbol),
            "brokerSymbol": broker_symbol,
            "side": "LONG" if is_buy else "SHORT",
            "volume": float(row.volume),
            "entry": float(row.price_open),
            "stopLoss": float(row.sl),
            "takeProfit": float(row.tp),
            "profit": float(row.profit),
            "swap": float(row.swap),
            "commission": 0.0,
            "openedAt": int(getattr(row, "time_msc", int(row.time) * 1000)),
            "magic": int(getattr(row, "magic", 0) or 0),
            "comment": str(getattr(row, "comment", "") or ""),
        }

    def _terminal_version(self) -> str | None:
        if not self.mt5:
            return None
        version = self.mt5.version()
        if not version:
            return None
        return ".".join(str(part) for part in version[:2])

    def _account_mode(self, value: int | None) -> str | None:
        if value is None:
            return None
        if value == int(getattr(self.mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)):
            return "demo"
        if value == int(getattr(self.mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1)):
            return "contest"
        return "real"

    @staticmethod
    def _comment(value: str) -> str:
        # MetaTrader/broker comment limits can be stricter than the nominal
        # platform maximum. This terminal accepted 28 characters but rejected
        # a 31-character close comment. Keep comments short, ASCII-only and
        # deterministic; idempotency is handled by the ledger, not comments.
        safe_value = "".join(
            character if character.isascii() and (character.isalnum() or character in "._-")
            else "-"
            for character in str(value)
        )
        comment = f"xau:{safe_value}".strip("-")
        return (comment or "xau")[:28]
