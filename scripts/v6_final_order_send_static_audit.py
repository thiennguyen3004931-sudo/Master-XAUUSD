"""G1 source-only audit of the final new-entry MT5 order-send boundary.

Never imports MT5, performs broker calls, modifies bot configuration or
authorizes a real order. AST is *syntactic evidence only*: no AST check can
prove Windows lock ownership, durable state, broker account or live safety.
"""
from __future__ import annotations

import ast
from typing import Any

from scripts.v6_runtime_boundary_attestation import map_mt5_order_send_call_sites

SCOPE = "STATIC_FINAL_NEW_ENTRY_BOUNDARY_AUDIT_NO_RUNTIME_AUTHORIZATION"
FINAL_ENTRY_FUNCTION = "_execute_order_serialized"
ENTRY_COORDINATOR = "execute_order"


def _named_calls(node: ast.AST, name: str) -> list[ast.Call]:
    return [
        item for item in ast.walk(node)
        if isinstance(item, ast.Call)
        and isinstance(item.func, ast.Name)
        and item.func.id == name
    ]


def _direct_sends(node: ast.AST) -> list[ast.Call]:
    return [
        item for item in ast.walk(node)
        if isinstance(item, ast.Call)
        and isinstance(item.func, ast.Attribute)
        and item.func.attr == "order_send"
        and isinstance(item.func.value, ast.Name)
        and item.func.value.id == "mt5"
    ]


def audit_final_new_order_source(source_text: str) -> dict[str, Any]:
    """Inspect the source, never certify the deployed runtime or broker.

    A direct send is mapped only when it visibly uses mt5.order_send(...).
    Aliases, getattr and dynamic dispatch are conservative unresolved gaps.
    """
    result: dict[str, Any] = {
        "scope": SCOPE,
        "staticEvidenceCollected": False,
        "runtimeFinalStopVerified": False,
        "interprocessLockIndependentlyVerified": False,
        "durableMarkerIndependentlyVerified": False,
        "brokerFillIndependentlyVerified": False,
        "hostAclIndependentlyVerified": False,
        "liveAuthorized": False,
        "admitted": False,
        "orderSendInvoked": False,
        "readyForLive": False,
    }
    if not isinstance(source_text, str) or not source_text.strip():
        return {**result, "reason": "SOURCE_MISSING_OR_INVALID"}
    try:
        tree = ast.parse(source_text)
    except (SyntaxError, ValueError, TypeError):
        return {**result, "reason": "SOURCE_PYTHON_AST_UNAVAILABLE"}

    functions = {
        node.name: node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    mapping = map_mt5_order_send_call_sites(source_text)
    entry = functions.get(ENTRY_COORDINATOR)
    serializer = functions.get(FINAL_ENTRY_FUNCTION)

    # Attribute references not directly invoked through mt5.order_send may
    # hide an aliased sender or an unrecognized client. Such sites are NOT
    # included in the existing direct-call mapper and must be reported.
    direct_attrs = {
        id(call.func) for call in ast.walk(tree)
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and call.func.attr == "order_send"
        and isinstance(call.func.value, ast.Name)
        and call.func.value.id == "mt5"
    }
    unmatched_send_references = [
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Attribute)
        and node.attr == "order_send" and id(node) not in direct_attrs
    ]
    dynamic_getattr = [
        node.lineno for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name) and node.func.id == "getattr"
        and len(node.args) >= 2
        and isinstance(node.args[1], ast.Constant)
        and node.args[1].value == "order_send"
    ]
    unknown = sorted(set(unmatched_send_references + dynamic_getattr))
    direct = mapping.get("callSites", [])
    entry_sites = [
        site for site in direct
        if site["category"] == "NEW_ORDER_ENTRY"
    ]
    protective_sites = [
        site for site in direct
        if site["category"] == "PROTECTIVE_OR_EXIT"
    ]
    known_sites_structural = (
        bool(mapping.get("allCallSitesClassified"))
        and len(entry_sites) == 1
        and len(protective_sites) == 3
        and not unknown
        and len(direct) == 4
    )

    # Only descriptive structural evidence: this is not a proof that those
    # functions ran, that a lock is cross-process, or that state was fsynced.
    lock_evidence = False
    marker_write_before_entry = False
    if entry is not None:
        for item in ast.walk(entry):
            if not isinstance(item, (ast.With, ast.AsyncWith)):
                continue
            if not any(
                isinstance(context.context_expr, ast.Call)
                and isinstance(context.context_expr.func, ast.Name)
                and context.context_expr.func.id == "_strict_new_order_lock"
                for context in item.items
            ):
                continue
            lock_evidence = True
            read = _named_calls(item, "_read_uncertain_entry_state")
            write = _named_calls(item, "_write_uncertain_entry_state")
            send = _named_calls(item, FINAL_ENTRY_FUNCTION)
            marker_write_before_entry = bool(
                read and write and send
                and min(x.lineno for x in read) < min(x.lineno for x in write)
                < min(x.lineno for x in send)
            )
            if marker_write_before_entry:
                break

    margin_before_send = False
    potential_final_stop_hook = False
    if serializer is not None:
        sends = _direct_sends(serializer)
        margin = _named_calls(serializer, "verify_last_moment_entry_margin")
        guarded_ifs = [
            node for node in ast.walk(serializer)
            if isinstance(node, ast.If)
            and "final_margin" in ast.unparse(node.test)
            and ".get(" in ast.unparse(node.test)
            and "ok" in ast.unparse(node.test)
        ]
        margin_before_send = bool(
            len(sends) == 1 and margin and guarded_ifs
            and min(x.lineno for x in margin)
            < min(x.lineno for x in guarded_ifs)
            < sends[0].lineno
        )
        # Finding a similarly named call is only a candidate, not proof it
        # reads durable, account-bound state immediately before the send.
        potential_final_stop_hook = any(
            _named_calls(serializer, name)
            for name in (
                "read_bound_emergency_stop_latch",
                "evaluate_new_order_gate",
                "evaluate_final_new_order_admission",
                "evaluate_runtime_final_new_entry_gate",
            )
        )

    missing: list[str] = []
    if not known_sites_structural:
        missing.append("ORDER_SEND_CALL_SITE_COVERAGE_UNVERIFIED")
    if not lock_evidence:
        missing.append("NEW_ENTRY_LOCK_CALL_NOT_OBSERVED")
    if not marker_write_before_entry:
        missing.append("PENDING_MARKER_PRECEDENCE_UNVERIFIED")
    if not margin_before_send:
        missing.append("LAST_MOMENT_MARGIN_GUARD_UNVERIFIED")
    if not potential_final_stop_hook:
        missing.append("FINAL_NEW_ENTRY_EMERGENCY_STOP_CALL_NOT_OBSERVED")
    missing.extend((
        "DURABLE_RUNTIME_STOP_AND_ACCOUNT_BINDING_NOT_ATTESTED",
        "WINDOWS_HOST_IDENTITY_ACL_AND_KEY_CUSTODY_NOT_ATTESTED",
        "BROKER_ACK_FILL_RECONCILIATION_NOT_ATTESTED",
    ))
    return {
        **result,
        "staticEvidenceCollected": True,
        "reason": "SOURCE_ONLY_RUNTIME_GATE_STILL_UNVERIFIED",
        "sourceSha256": mapping.get("sourceSha256"),
        "directOrderSendSiteCount": len(direct),
        "newEntryDirectSites": entry_sites,
        "protectiveOrExitDirectSites": protective_sites,
        "unmappedOrAliasedOrderSendLines": unknown,
        "directCallSiteStructureObserved": known_sites_structural,
        "newEntryLockCallObserved": lock_evidence,
        "pendingMarkerWriteBeforeSerializerCallObserved": marker_write_before_entry,
        "lastMomentMarginGuardBeforeSendObserved": margin_before_send,
        "potentialFinalEmergencyStopHookCallObserved": potential_final_stop_hook,
        "missingOrUnverifiedGates": missing,
    }
