# Phase7C Mobile Remote M2 Production Read-Only Preflight Implementation Plan

**Goal:** Add a source-tested, PowerShell-parse-tested, fail-closed read-only preflight that decides whether production is ready for a later M2 Tailscale activation without performing any production mutation.

**Architecture:** Reuse the already-merged M2 gateway contract as the canonical read-only surface. Add one standalone PowerShell preflight that only reads git/runtime/Web/Tailscale/listener state. Extend the existing M2 source-contract test and CI workflow so the new script is required, statically mutation-bounded, and PowerShell-parsed.

**Spec:** `docs/superpowers/specs/2026-09-13-phase7c-mobile-remote-m2-production-readonly-preflight.md`

---

## Task 1 — TDD RED: require the missing preflight

**Files:**
- Modify: `scripts/test-phase7c-mobile-remote-m2.mjs`
- Modify: `.github/workflows/phase7c-mobile-remote-m2-ci.yml`

Add a required read of `scripts/preflight-phase7c-mobile-remote-m2-production-readonly-local.ps1` and static contract assertions for safety invariants, agreed output tokens, ports `5717/5791/8443`, local mobile path, read-only Tailscale status commands, and explicit absence of mutation primitives. Add the new script to workflow path filters and Windows PowerShell parsing.

**RED proof:** Open a PR before creating the preflight script. The M2 source-contract and/or PowerShell parse job must fail because the required file is absent. Record the failing workflow run.

## Task 2 — Minimal GREEN implementation

**File:**
- Create: `scripts/preflight-phase7c-mobile-remote-m2-production-readonly-local.ps1`

Implement only read-only checks:

1. Require an expected canonical commit argument; verify local clean `main` and exact HEAD.
2. GET `/api/v1/phase7c/runtime-source-attestation`; require HTTP success and expected commit evidence.
3. GET `/phase7c-mobile`.
4. GET the exact API/query set already allowed by `run-phase7c-mobile-readonly-gateway.mjs`.
5. Run read-only `tailscale status --json`; require backend `Running`.
6. Run read-only Serve/Funnel status commands; fail closed on occupied/ambiguous state.
7. Read TCP listener state for local port `5791`; if occupied, report PID/process metadata and fail closed.
8. Print the agreed deterministic output contract and exit non-zero unless every gate passes.

The implementation must not call start/stop scripts and must not contain task/process/firewall/trading/Tailscale mutation commands.

## Task 3 — GREEN / CI verification

Commit the implementation to the same PR. Verify:

- `node scripts/test-phase7c-mobile-remote-m2.mjs` passes in CI.
- existing gateway behavior test passes.
- Windows PowerShell parser accepts start/stop/preflight scripts.
- no unrelated workflow regresses.

## Task 4 — Diff review and merge gate

Compare the feature branch against the exact base commit. Confirm the diff is limited to spec/plan/test/workflow/new preflight and that no trading/runtime source was modified. Merge only when all required PR checks are green.

## Task 5 — Stop before production activation

After merge, report the new canonical main SHA. Do not enable Tailscale Serve or mutate production. Production execution of the preflight is a separate evidence step; only a real host run may establish `READY_FOR_M2_ACTIVATION=TRUE`.
