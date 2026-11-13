# SEMI Auto Trend Management Implementation Plan

**Goal:** Add a fail-closed `SEMI` operating mode where the bot creates no entries, but can adopt eligible manual XAUUSD positions opened after the SEMI activation epoch, protect them with canonical 6.0-price-unit initial SL / Trend Fixed TP, and then hand them into the existing Trend management stack.

**Architecture:** Extend the canonical mode contract first. Add a dedicated manual-adoption gateway in the API layer that owns provenance, activation-epoch eligibility, initial protection reconciliation, and adoption state. The gateway must produce/maintain a durable Trend-compatible execution identity only after broker protection is confirmed; the existing Trend management runtime remains the sole management engine. UI/API observability surfaces adoption/protection state without creating a second management path.

**Safety invariants:** `SEMI` never creates entries; pre-existing positions are never retro-adopted; unknown provenance is rejected; `UNMANAGED` alone is not proof of manual ownership; initial SL is exactly 6.0 XAUUSD price units normalized to broker tick size; stops/freeze constraints remain authoritative; failed protection stays `PENDING/PROTECTION_BLOCKED`; canonical Trend Fixed TP wins over any differing manual TP; AUTO/TREND/SIDEWAY/PAUSE behavior must not regress.

---

## Task 1 — Extend canonical mode contract with RED tests

**Files**
- Modify: `packages/strategy-engine/src/models/BotMode.ts`
- Modify: `apps/api/src/services/phase7c-bot-mode.service.ts`
- Create: `apps/api/src/services/phase7c-bot-mode.semi.test.ts`

**RED:** Add contract tests proving `SEMI` is currently rejected and that entering SEMI records an activation epoch through canonical mode state/audit semantics.

**GREEN:** Add `SEMI` to `BotMode` and API valid modes. Keep AUTO source restriction unchanged. Treat SEMI as a non-PAUSE state for durable state + audit ordering. Preserve PAUSE fail-safe behavior.

**Verification:** run the focused test with `pnpm exec tsx apps/api/src/services/phase7c-bot-mode.semi.test.ts`, then `pnpm --filter @xauusd/api build`.

## Task 2 — Add pure manual-adoption eligibility/protection contract

**Files**
- Create: `apps/api/src/services/phase7c-semi-manual-adoption.service.ts`
- Create: `apps/api/src/services/phase7c-semi-manual-adoption.test.ts`

**RED cases**
1. mode != SEMI -> reject;
2. position opened before/equal activation epoch -> reject;
3. system magic/comment provenance -> reject;
4. unknown/insufficient provenance -> reject;
5. eligible manual BUY/SELL -> compute exact directional 6.0-price-unit SL;
6. normalize SL/TP to broker tick size;
7. illegal stops/freeze placement -> `PENDING/PROTECTION_BLOCKED`;
8. Fixed TP enabled + differing broker TP -> canonical Trend TP required;
9. no broker confirmation -> never mark `PROTECTED` or `MANAGED`;
10. repeated evaluation is idempotent.

**GREEN:** Implement deterministic classifier and protection planner with explicit reason codes. No broker mutation in this pure layer.

## Task 3 — Persist adoption state and bridge it to the existing Trend durable identity

**Files**
- Create: `apps/api/src/services/phase7c-semi-adoption-state.service.ts`
- Create: `apps/api/src/services/phase7c-semi-adoption-state.test.ts`
- Modify: `apps/api/src/services/sqlite-execution.repository.ts`
- Modify only as required: `packages/execution-engine/src/models/ExecutionRecord.ts`

**RED:** Prove restart/idempotence, one ticket = one adoption record, activation epoch retained, protection status transitions only `PENDING -> PROTECTION_BLOCKED|PROTECTED -> MANAGED`, and no synthetic fill/open event is emitted for manual adoption.

**GREEN:** Persist ownership metadata needed by Trend management while retaining explicit `origin=MANUAL_SEMI`. Do not forge broker execution provenance; store adoption provenance separately from the original fill.

## Task 4 — Execute canonical broker protection before Trend handoff

**Files**
- Create: `apps/api/src/services/phase7c-semi-protection-executor.service.ts`
- Create: `apps/api/src/services/phase7c-semi-protection-executor.test.ts`
- Reuse broker mutation primitives from existing controlled-management execution path.
- Modify: `apps/api/src/services/controlled-management-executor.service.ts` only if a safe shared mutation helper must be extracted.

**RED:** Mock broker responses for accepted, rejected, freeze/stops violation, stale position, ticket mismatch, and partial confirmation. Assert fail-closed state and no Trend handoff until a fresh broker read confirms canonical SL (and Fixed TP when enabled).

**GREEN:** Apply only bounded SL/TP modification to the eligible manual ticket. Never open/close/add volume. After mutation, re-read broker state; promote to `PROTECTED` only on exact normalized canonical protection.

## Task 5 — Handoff protected manual ticket into the one existing Trend management engine

**Files**
- Modify: `apps/api/src/services/trend-management-runtime.service.ts`
- Create: `apps/api/src/services/trend-management-runtime.semi.test.ts`

**RED:** Existing runtime should reject a manual ticket because it is not durable system-owned. Add tests for a validated SEMI adoption identity, while preserving rejection of arbitrary unmanaged/unknown tickets.

**GREEN:** Allow one additional ownership class: durable, `MANUAL_SEMI`, `PROTECTED` adoption identity for the active activation epoch. Keep all existing TrendContinuation plan requirements, broker ticket matching, single-position guards, M15 freshness, Fixed TP/FastMove/trailing/BE logic, and state persistence unchanged.

## Task 6 — Enforce SEMI entry suppression and expose observability/UI

**Files**
- Modify: `apps/api/src/services/phase7c-strategy-entry-conditions.service.ts`
- Modify: `apps/api/src/services/phase7c-decision-monitor.service.ts`
- Modify: `apps/api/src/services/phase7c-ui-contract.service.ts`
- Modify: `apps/web/src/api.ts`
- Modify the Phase7C control page under `apps/web/src/pages/` identified during implementation.
- Add focused API/UI contract tests adjacent to existing Phase7C contract tests.

**RED:** Prove SEMI can never return an executable system entry, and UI contract reports `mode=SEMI`, `entryPolicy=MANUAL_ONLY`, adoption ticket/origin/protection status/reason without interpreting unknown strategy as TREND.

**GREEN:** Add SEMI mode option and status copy. Do not make SEMI imply TREND strategy selection for signal display; it is an operating mode governing entry ownership.

## Task 7 — Regression, CI, PR

Run focused RED/GREEN tests after each task, then repository gates appropriate to changed packages, including at minimum:
- `pnpm --filter @xauusd/strategy-engine build`
- `pnpm --filter @xauusd/api build`
- `pnpm --filter @xauusd/web build`
- existing Phase7C canonical contract workflows covering bot mode, entry safety, multi-position fail-closed, Trend management, Fixed TP/FastMove, and UI contract.

Create a PR from `feat/semi-auto-trend-management-20260909` to `main`. Do not roll out production or mutate live/demo runtime as part of this source implementation. Production rollout requires a separate bounded acceptance step after CI is green.
