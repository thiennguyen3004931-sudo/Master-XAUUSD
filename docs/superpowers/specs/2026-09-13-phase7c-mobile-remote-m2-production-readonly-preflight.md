# Phase7C Mobile Remote M2 Production Read-Only Preflight Spec

Date: 2026-09-13
Base: `main` at `6190be9991b421115a4c2e2413a2b4e975e9dc5d`

## Goal

Add a bounded, fail-closed production preflight for the already-merged private Tailscale Mobile Remote M2 design. The preflight proves whether the host is ready for a later, separately-authorized activation. This phase does not activate Tailscale Serve and does not mutate trading/runtime/network state.

## Safety invariants

```text
READ_ONLY=TRUE
HTTP_METHODS=GET_ONLY
TAILSCALE_SERVE_MUTATION=NONE
TAILSCALE_FUNNEL_MUTATION=NONE
GATEWAY_START_STOP=NONE
FIREWALL_MUTATION=NONE
TASK_MUTATION=NONE
PROCESS_MUTATION=NONE
BOT_RESTART=NONE
WEB_RESTART=NONE
API_RESTART=NONE
MT5_RESTART=NONE
MODE_MUTATION=NONE
ARM_MUTATION=NONE
ORDER_MUTATION=NONE
POSITION_MUTATION=NONE
SL_TP_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```

## Read-only checks

1. Local git source is clean, on `main`, and equals the expected canonical commit supplied to the preflight.
2. Runtime source attestation is reachable from the local Web and includes the expected canonical commit.
3. `http://127.0.0.1:5717/phase7c-mobile` is reachable by GET.
4. Every API consumed by the M2 read-only gateway is reachable by GET using its exact existing query contract.
5. `tailscale status --json` reports a running backend.
6. Tailscale Serve HTTPS port `8443` is not already configured/owned.
7. Local TCP gateway port `5791` is free. If occupied, report the owning PID/process and fail closed.
8. No public Tailscale Funnel configuration is detected. If the Funnel state cannot be established safely, fail closed.

## Required output contract

```text
PHASE7C_MOBILE_REMOTE_M2_PRODUCTION_PREFLIGHT=PASS|FAIL
READY_FOR_M2_ACTIVATION=TRUE|FALSE
SOURCE_ATTESTATION=PASS|FAIL
LOCAL_MOBILE_WEB=PASS|FAIL
READONLY_API_SET=PASS|FAIL
TAILSCALE_BACKEND=RUNNING|...
SERVE_8443=FREE|OCCUPIED|UNKNOWN
GATEWAY_5791=FREE|OCCUPIED|UNKNOWN
PUBLIC_FUNNEL=NONE|DETECTED|UNKNOWN
```

A failed or indeterminate safety check must produce `READY_FOR_M2_ACTIVATION=FALSE` and a non-zero exit code.

## Non-goals

- Do not run the M2 activation/start script.
- Do not run the M2 stop/rollback script.
- Do not start/stop processes, tasks, Web, API, MT5, broker, executors, or gateway.
- Do not change Windows Firewall.
- Do not create, alter, reset, enable, or disable Tailscale Serve/Funnel configuration.
- Do not change MODE, ARM, orders, positions, SL, TP, or any trading logic.
- Do not create a LIVE test order.

## Delivery gates

`TDD RED → minimal source fix → GREEN → CI → diff review → merge only if all gates pass.`
