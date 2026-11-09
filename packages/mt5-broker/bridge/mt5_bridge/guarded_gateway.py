from __future__ import annotations

import uuid
from typing import Any

from .config import Settings
from .errors import BridgeError
from .ledger import IdempotencyLedger
from .live_arm import LiveArmDecision, evaluate_live_arm
from .models import CloseRequest, ModifyRequest
from .mt5_gateway import Mt5Gateway


class GuardedMt5Gateway(Mt5Gateway):
    """MT5 gateway with a process-bound fail-closed guard for REAL exposure.

    The legacy real-account environment flags remain capability prerequisites,
    but they never authorize new REAL exposure by themselves. A valid LIVE arm
    is required for exposure-increasing mutations. Risk-reducing management of
    an already-open position remains available while DISARMED, but every base
    trading/account/allowlist/AutoTrading check still applies.
    """

    def __init__(
        self,
        settings: Settings,
        ledger: IdempotencyLedger,
        module: Any | None = None,
    ) -> None:
        super().__init__(settings, ledger, module)
        self.bridge_session_id = uuid.uuid4().hex

    def _live_arm_decision_from_identity(
        self,
        account_login: Any | None,
        account_server: Any | None,
    ) -> LiveArmDecision:
        if account_login is None:
            return LiveArmDecision(False, "ACCOUNT_UNAVAILABLE")
        return evaluate_live_arm(
            path=self.settings.live_arm_state_path,
            bridge_session_id=self.bridge_session_id,
            configured_account_mode=self.settings.account_mode,
            account_login=int(account_login or 0),
            account_server=str(account_server or ""),
            terminal_path=self.settings.terminal_path,
            compatibility_enabled=self.settings.live_compatibility_enabled,
        )

    def _live_arm_decision(self, account: Any | None) -> LiveArmDecision:
        if account is None:
            return LiveArmDecision(False, "ACCOUNT_UNAVAILABLE")
        return self._live_arm_decision_from_identity(
            getattr(account, "login", None),
            getattr(account, "server", None),
        )

    def health(self, reconnect: bool = True) -> dict[str, Any]:
        base = super().health(reconnect=reconnect)
        connected = bool(base.get("connected"))
        actual_mode = str(base.get("accountMode") or "")

        decision = LiveArmDecision(False, "NOT_REQUIRED")
        if connected and actual_mode == "real":
            # Base health already captured the account identity while owning the
            # MT5 gateway lock. Reuse that immutable identity here instead of
            # probing terminal_info/account_info a second time.
            decision = self._live_arm_decision_from_identity(
                base.get("accountLogin"),
                base.get("server"),
            )
        elif connected and self.settings.account_mode == "LIVE":
            decision = LiveArmDecision(False, "ACCOUNT_MODE_MISMATCH")

        arm_scope = None
        if decision.state:
            if int(decision.state.get("version", 0) or 0) == 2:
                arm_scope = str(decision.state.get("scope") or "") or None
            elif int(decision.state.get("version", 0) or 0) == 1:
                arm_scope = "LEGACY_TTL"

        return {
            **base,
            "configuredAccountMode": self.settings.account_mode,
            "bridgeSessionId": self.bridge_session_id,
            "liveArmRequired": actual_mode == "real" or self.settings.account_mode == "LIVE",
            "liveExecutionArmed": bool(decision.armed),
            "liveArmStatus": "ARMED" if decision.armed else ("NOT_REQUIRED" if decision.reason == "NOT_REQUIRED" else "DISARMED"),
            "liveArmReason": decision.reason,
            "liveArmScope": arm_scope,
            "liveRiskReductionAllowedWhenDisarmed": True,
        }

    def pending_orders(
        self,
        canonical_symbol: str | None = None,
        reconnect: bool = True,
    ) -> list[dict[str, Any]]:
        """Read-only broker pending-order snapshot used by LIVE arm preflight."""
        broker_symbol = self.settings.broker_symbol(canonical_symbol) if canonical_symbol else None
        with self._lock:
            rows = (
                self._read_with_reconnect_locked(
                    "orders_get",
                    symbol=broker_symbol,
                    reconnect=reconnect,
                )
                if broker_symbol
                else self._read_with_reconnect_locked("orders_get", reconnect=reconnect)
            )
        if rows is None:
            raise BridgeError(
                f"orders_get failed: {self.mt5.last_error()}",
                503,
                "PENDING_ORDERS_UNAVAILABLE",
            )
        return [
            {
                "ticket": str(getattr(row, "ticket", "")),
                "symbol": self.settings.canonical_symbol(str(getattr(row, "symbol", "") or "")),
                "brokerSymbol": str(getattr(row, "symbol", "") or ""),
                "type": int(getattr(row, "type", -1)),
                "volume": float(getattr(row, "volume_initial", 0.0) or 0.0),
                "price": float(getattr(row, "price_open", 0.0) or 0.0),
                "magic": int(getattr(row, "magic", 0) or 0),
                "comment": str(getattr(row, "comment", "") or ""),
            }
            for row in rows
        ]

    def close_position(self, ticket: str, request: CloseRequest) -> dict[str, Any]:
        """Reduce or close existing exposure even if the LIVE arm is absent."""
        key = f"command:{request.commandId}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        try:
            self._require_trading("REDUCE_RISK")
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
        """Allow only non-loosening protection changes while LIVE is DISARMED."""
        key = f"command:{request.commandId}"
        replay = self._reserve_or_replay(key)
        if replay is not None:
            return replay
        try:
            self._require_trading("REDUCE_RISK")
            with self._lock:
                positions = self.mt5.positions_get(ticket=int(ticket))
                if not positions:
                    raise BridgeError(f"Position {ticket} was not found", 404, "POSITION_NOT_FOUND")
                position = positions[0]
                self._authorize_position_modify(position, request)
                payload = {
                    "action": self.mt5.TRADE_ACTION_SLTP,
                    "symbol": position.symbol,
                    "position": int(position.ticket),
                    "sl": float(request.stopLoss),
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

    def _authorize_position_modify(self, position: Any, request: ModifyRequest) -> None:
        """Fail closed on any protection change that can increase LIVE risk."""
        with self._lock:
            _, account = self._connection_snapshot_locked(reconnect=True)
        if account is None:
            raise BridgeError("MT5 terminal is disconnected", 503, "TERMINAL_DISCONNECTED")

        if self._account_mode(int(account.trade_mode)) != "real":
            return
        if self._live_arm_decision(account).armed:
            return

        current_tp = float(getattr(position, "tp", 0.0) or 0.0)
        requested_tp = current_tp if request.takeProfit is None else float(request.takeProfit)
        if abs(requested_tp - current_tp) > 1e-9:
            raise BridgeError(
                "DISARMED LIVE protection change cannot alter take-profit",
                423,
                "LIVE_RISK_INCREASE_BLOCKED",
            )

        current_sl = float(getattr(position, "sl", 0.0) or 0.0)
        requested_sl = float(request.stopLoss)
        if current_sl <= 0.0:
            return

        position_type = int(getattr(position, "type", -1))
        buy_type = int(getattr(self.mt5, "POSITION_TYPE_BUY", 0))
        sell_type = int(getattr(self.mt5, "POSITION_TYPE_SELL", 1))
        if position_type == buy_type and requested_sl + 1e-9 >= current_sl:
            return
        if position_type == sell_type and requested_sl - 1e-9 <= current_sl:
            return

        raise BridgeError(
            "DISARMED LIVE protection change would loosen stop-loss",
            423,
            "LIVE_RISK_INCREASE_BLOCKED",
        )

    def _require_trading(self, mutation: str = "OPEN_RISK") -> None:
        # Preserve every existing bridge-level check first: trading switch,
        # connectivity, allowlist, real-account capability and AutoTrading.
        super()._require_trading()

        with self._lock:
            terminal, account = self._connection_snapshot_locked(reconnect=True)
        if terminal is None or account is None:
            raise BridgeError("MT5 terminal is disconnected", 503, "TERMINAL_DISCONNECTED")

        actual_mode = self._account_mode(int(account.trade_mode))
        configured = self.settings.account_mode
        expected_actual = "real" if configured == "LIVE" else "demo"
        if actual_mode != expected_actual:
            raise BridgeError(
                f"Configured account mode {configured} does not match connected MT5 mode {actual_mode}",
                423,
                "ACCOUNT_MODE_MISMATCH",
            )

        if actual_mode != "real":
            return

        decision = self._live_arm_decision(account)
        if decision.armed:
            return
        if str(mutation).upper() == "REDUCE_RISK":
            return

        raise BridgeError(
            f"LIVE execution is DISARMED: {decision.reason}",
            423,
            "LIVE_EXECUTION_DISARMED",
        )
