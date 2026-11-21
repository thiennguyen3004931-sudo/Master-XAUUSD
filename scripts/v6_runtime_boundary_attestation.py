"""G1 read-only runtime boundary attestation & order_send call-site contract (#7).

Strictly READ-ONLY / OFFLINE:
- NEVER imports MetaTrader5, NEVER calls real `order_send`, NEVER installs live hooks,
  and NEVER mutates ARM/runtime config.
- Provides:
  1. AST-based static call-site mapper (`map_mt5_order_send_call_sites`) that locates
     every `mt5.order_send(...)` call in `scripts/mt5-direct-probe.py` (or source text),
     classifies `NEW_ORDER_ENTRY` vs `PROTECTIVE_OR_EXIT`, and fails closed if any
     unknown/unmapped `order_send` call site appears.
  2. Offline new-entry boundary evaluator (`evaluate_new_entry_boundary_under_lock`)
     verifying account/server binding, non-reentrant lock ownership, pending-entry
     marker write BEFORE `order_send`, and crash/unknown-ACK fail-closed latching,
     while keeping `PROTECTIVE_OR_EXIT` actions unblocked by new-entry latches.
"""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import threading
import time
from typing import Any, Callable

KNOWN_NEW_ENTRY_FUNCTIONS = frozenset({"_execute_order_serialized"})
KNOWN_PROTECTIVE_OR_EXIT_FUNCTIONS = frozenset({
    "partial_close_position",
    "modify_position_sl_tp",
    "close_position_by_ticket",
})


class _OrderSendVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self._func_stack: list[str] = []
        self.call_sites: list[dict[str, Any]] = []

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._func_stack.append(node.name)
        self.generic_visit(node)
        self._func_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._func_stack.append(node.name)
        self.generic_visit(node)
        self._func_stack.pop()

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        is_mt5_order_send = (
            isinstance(func, ast.Attribute)
            and func.attr == "order_send"
            and isinstance(func.value, ast.Name)
            and func.value.id == "mt5"
        )
        if is_mt5_order_send:
            enclosing = self._func_stack[-1] if self._func_stack else "<module>"
            if enclosing in KNOWN_NEW_ENTRY_FUNCTIONS:
                category = "NEW_ORDER_ENTRY"
            elif enclosing in KNOWN_PROTECTIVE_OR_EXIT_FUNCTIONS:
                category = "PROTECTIVE_OR_EXIT"
            else:
                category = "UNKNOWN_ORDER_SEND_CALL_SITE"
            self.call_sites.append({
                "function": enclosing,
                "line": int(node.lineno),
                "category": category,
            })
        self.generic_visit(node)


def map_mt5_order_send_call_sites(source_text: str) -> dict[str, Any]:
    """Parse Python source via AST and classify every `mt5.order_send` call site."""
    tree = ast.parse(source_text)
    visitor = _OrderSendVisitor()
    visitor.visit(tree)

    sites = sorted(visitor.call_sites, key=lambda item: (item["line"], item["function"]))
    unknown_sites = [s for s in sites if s["category"] == "UNKNOWN_ORDER_SEND_CALL_SITE"]
    new_entry_sites = [s for s in sites if s["category"] == "NEW_ORDER_ENTRY"]
    protective_sites = [s for s in sites if s["category"] == "PROTECTIVE_OR_EXIT"]

    return {
        "totalCallSites": len(sites),
        "callSites": sites,
        "newEntrySites": new_entry_sites,
        "protectiveOrExitSites": protective_sites,
        "unknownSites": unknown_sites,
        "allCallSitesClassified": len(sites) > 0 and len(unknown_sites) == 0,
        "allPossibleOrderSendPathsVerified": False,
        "mappingScope": "DIRECT_AST_MT5_ORDER_SEND_ONLY_NOT_RUNTIME_ATTESTED",
        "sourceSha256": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
    }


def evaluate_action_boundary(
    *,
    action_category: str,
    emergency_stop_active: bool,
    uncertain_entry_latched: bool,
    expected_account_login: int,
    expected_server: str,
    observed_account_login: int,
    observed_server: str,
    entry_lock_held: bool,
    pending_marker_persisted: bool,
) -> dict[str, Any]:
    """Pure contract check separating `PROTECTIVE_OR_EXIT` from `NEW_ORDER_ENTRY`."""
    if action_category == "PROTECTIVE_OR_EXIT":
        return {
            "actionCategory": action_category,
            "allowed": False,
            "protectiveUnaffectedByNewEntryLatch": True,
            "liveAuthorized": False,
            "reason": "PROTECTIVE_REQUIRES_OWN_INDEPENDENT_AUTHORIZATION",
        }

    if action_category != "NEW_ORDER_ENTRY":
        return {
            "actionCategory": action_category,
            "allowed": False,
            "reason": "UNKNOWN_ACTION_CATEGORY_FAIL_CLOSED",
        }

    if not entry_lock_held:
        return {"actionCategory": action_category, "allowed": False, "reason": "ENTRY_LOCK_NOT_HELD"}
    if emergency_stop_active:
        return {"actionCategory": action_category, "allowed": False, "reason": "EMERGENCY_STOP_LATCHED"}
    if uncertain_entry_latched:
        return {"actionCategory": action_category, "allowed": False, "reason": "UNCERTAIN_ENTRY_LATCHED"}
    try:
        expected_login = int(expected_account_login)
        observed_login = int(observed_account_login)
    except (TypeError, ValueError, OverflowError):
        return {"actionCategory": action_category, "allowed": False, "reason": "ACCOUNT_BINDING_MISMATCH"}
    if isinstance(expected_account_login, bool) or isinstance(observed_account_login, bool) or expected_login <= 0 or observed_login != expected_login:
        return {"actionCategory": action_category, "allowed": False, "reason": "ACCOUNT_BINDING_MISMATCH"}
    if not str(expected_server or "").strip() or str(observed_server or "").strip() != str(expected_server).strip():
        return {"actionCategory": action_category, "allowed": False, "reason": "SERVER_BINDING_MISMATCH"}
    if not pending_marker_persisted:
        return {"actionCategory": action_category, "allowed": False, "reason": "PENDING_MARKER_NOT_PERSISTED"}

    return {
        "actionCategory": action_category,
        "allowed": False,
        "offlineChecksPassed": True,
        "liveAuthorized": False,
        "reason": "OFFLINE_BOUNDARY_CHECKLIST_PASSED_NOT_RUNTIME_AUTHORIZED",
    }


def simulate_locked_new_order_with_pending_marker(
    *,
    entry_lock: threading.Lock,
    pending_marker_path: Path,
    request_id: str,
    expected_account_login: int,
    expected_server: str,
    observed_account_login: int,
    observed_server: str,
    emergency_stop_active: bool,
    mock_order_send: Callable[[dict[str, Any]], dict[str, Any] | None],
    now_utc: float | None = None,
) -> dict[str, Any]:
    """Simulate `_strict_new_order_lock` new-entry execution with crash/unknown-ACK latch."""
    ts = int(time.time() if now_utc is None else now_utc)
    # threading.Lock is a mock *in-process* lock, NOT the interprocess
    # runtime lock. Check the entire existing marker inside the lock and
    # refuse EVERY existing state until independently reconciled.
    with entry_lock:
        if pending_marker_path.exists():
            try:
                existing = json.loads(pending_marker_path.read_text(encoding="utf-8"))
                if not isinstance(existing, dict):
                    existing = {"status": "UNVERIFIED_EXISTING_MARKER"}
            except Exception:
                existing = {"status": "CORRUPT_MARKER"}
            return {
                "sent": False, "latchedUncertain": True,
                "liveAuthorized": False,
                "reason": "PRIOR_UNVERIFIED_ENTRY_MARKER_BLOCKS_NEW_ORDER",
                "marker": existing,
            }

        marker_payload = {
            "requestId": str(request_id),
            "accountLogin": int(expected_account_login),
            "server": str(expected_server),
            "status": "PENDING_SEND",
            "writtenAtUtc": ts,
        }
        pending_marker_path.write_text(json.dumps(marker_payload, sort_keys=True), encoding="utf-8")

        decision = evaluate_action_boundary(
            action_category="NEW_ORDER_ENTRY",
            emergency_stop_active=emergency_stop_active,
            uncertain_entry_latched=False,
            expected_account_login=expected_account_login,
            expected_server=expected_server,
            observed_account_login=observed_account_login,
            observed_server=observed_server,
            entry_lock_held=entry_lock.locked(),
            pending_marker_persisted=pending_marker_path.exists(),
        )
        if not decision.get("offlineChecksPassed"):
            marker_payload["status"] = "ABORTED_BEFORE_SEND"
            marker_payload["reason"] = decision["reason"]
            pending_marker_path.write_text(json.dumps(marker_payload, sort_keys=True), encoding="utf-8")
            return {
                "sent": False,
                "latchedUncertain": False,
                "reason": decision["reason"],
                "marker": marker_payload,
            }

        try:
            ack = mock_order_send({
                "requestId": str(request_id),
                "accountLogin": int(observed_account_login),
                "server": str(observed_server),
            })
        except Exception as exc:
            marker_payload["status"] = "CRASH_OR_EXCEPTION"
            marker_payload["errorType"] = type(exc).__name__
            pending_marker_path.write_text(json.dumps(marker_payload, sort_keys=True), encoding="utf-8")
            return {
                "sent": True,
                "latchedUncertain": True,
                "reason": f"ORDER_SEND_EXCEPTION_{type(exc).__name__}",
                "marker": marker_payload,
            }

        # Even a successful MOCK acknowledgement is not verified broker fill
        # evidence. Do not clear the marker until independent broker readback.
        marker_payload["status"] = "UNKNOWN_ACK"
        marker_payload["mockAckLooksSuccessful"] = bool(
            isinstance(ack, dict) and ack.get("retcode") == 10009 and ack.get("order")
        )
        pending_marker_path.write_text(json.dumps(marker_payload, sort_keys=True), encoding="utf-8")
        return {
            "sent": True, "latchedUncertain": True,
            "liveAuthorized": False,
            "reason": "MOCK_ACK_NOT_BROKER_CONFIRMED",
            "marker": marker_payload,
        }
