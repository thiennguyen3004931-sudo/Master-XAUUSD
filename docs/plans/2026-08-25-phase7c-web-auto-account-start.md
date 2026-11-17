# Phase7C Web Auto-Account Start Implementation Plan

**Goal:** Make the existing Web `BẬT BOT` action work with the MT5 account type that is actually connected at click time (DEMO or LIVE), while never granting first-time LIVE execution permission from the Web.

**Safety invariants**

- Web never changes the MT5 login/account itself; it only detects the broker account mode reported by the local bridge.
- DEMO may be selected automatically when the bridge reports `demo`.
- LIVE may be selected automatically only when durable prior LIVE authorization is valid, or when upgrading from an already-valid explicitly enabled LIVE runtime state.
- Durable LIVE authorization is bound to the configured LIVE login/server/terminal fingerprint and is invalidated by identity drift.
- Web never creates first-time LIVE authorization from a DEMO/unconfigured state.
- Start always enters/keeps `PAUSE` during preflight and only changes to `AUTO` after executor READY plus a fresh final MT5 safety check.
- Unknown/contest/disconnected modes, missing account profile, missing authorization, open XAUUSD positions, disabled trading, or identity mismatch fail closed.
- Tests/CI do not start MT5, arm LIVE, switch runtime mode, or place orders.

## Task 1 — RED regression coverage

Files:
- Create `scripts/test-phase7c-web-auto-account-start.ts`
- Modify `.github/workflows/phase7c-dual-account-mode-ci.yml`

Add policy tests for DEMO, authorized LIVE, legacy-valid LIVE migration eligibility, unauthorized LIVE, malformed/contest/unreachable modes, and identity mismatch. Add static wiring assertions that Web lifecycle start uses broker detection and that first-time LIVE authorization cannot be written by the Web path. Run CI and confirm failure occurs because the new policy/authorization implementation is absent.

## Task 2 — Durable LIVE authorization

Files:
- Create `apps/api/src/services/phase7c-live-authorization.service.ts`
- Modify `scripts/lib/phase7c-account-mode.ps1`
- Modify `scripts/switch-phase7c-account-mode-local.ps1`

Persist a non-expiring authorization record only after explicit `-ConfirmLiveExecution` flow succeeds. Bind it to LIVE profile identity. Add a one-time legacy migration path only when the existing runtime state is already valid LIVE with `liveExecutionEnabled=true` and the currently connected broker is LIVE/server-compatible.

## Task 3 — Broker-driven Web account selection

Files:
- Create `apps/api/src/services/phase7c-web-account-start-policy.ts`
- Modify `apps/api/src/services/phase7c-account-mode.service.ts`
- Modify `apps/api/src/services/phase7c-lot-settings.service.ts`
- Modify `apps/api/src/services/phase7c-lifecycle.service.ts`

Resolve target account from fresh telemetry, validate prior LIVE authorization when needed, activate the account-specific risk profile, atomically update selected runtime account mode, then launch the existing Phase7C supervisor with DEMO or LIVE arguments. LIVE supervisor launch must pass `-LiveExecutionEnabled` only after authorization validation.

## Task 4 — Web UI and contract

Files:
- Modify `apps/api/src/routes/phase7c.route.ts`
- Modify `apps/web/src/phase7c-types.ts`
- Modify `apps/web/src/pages/Phase7CControlCenterPage.tsx`

Keep one `BẬT BOT` button. Remove the DEMO-only disable condition. Show detected broker mode and LIVE authorization readiness. Explain that LIVE requires prior authorization and that the button does not change the MT5 login.

## Task 5 — Verification

Run targeted auto-account tests, existing dual-account tests, API/Web builds, and relevant Phase7C regression workflows. Review the final diff for fail-open paths. Do not perform a LIVE AUTO runtime test or send an order as part of code verification; deployment/runtime verification remains PAUSE/read-only until separately authorized by the operator.
