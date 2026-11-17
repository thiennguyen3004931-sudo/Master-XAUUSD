# Phase7C Activation Sideway Cap Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Phase7C safe/base activation path enforce the same canonical lot contract already merged into API, Web, supervisor, and controller boundaries.

**Architecture:** Keep the recovery flow unchanged. Add a regression contract to the existing lot-settings test, then minimally split base activation validation so Trend remains an executed managed lot (`0.03..0.06`, step `0.03`) while Sideway max remains an Auto-Lot cap (`0.03..0.04`, broker step `0.01`). `activate-phase7c-safe-local.ps1` continues delegating values to base activation and always returns the runtime to PAUSE.

**Tech Stack:** Node.js `node:test`, PowerShell 5+/7 parser/runtime, existing Phase7C GitHub Actions workflows.

**Spec:** PR #109 final lot contract and `scripts/phase7c-lot-settings.test.mjs` on the current `main` source tree `c8f84bddb559de2b4db46ff08823b142686c1a02`.

## Global Constraints

- Trend fixed lot: `0.03..0.06`, step `0.03`, exact-one-third compatible.
- Sideway Auto-Lot cap: `0.03..0.04`, broker step `0.01`.
- Actual Sideway executed order volume remains canonical Auto-Lot `recommendedLot` and exact-one-third compatible.
- Safe activation must finish in `PAUSE`.
- No Windows deployment, no ARM/AUTO mutation, no MT5 order test, no real Telegram send during source work.

---

### Task 1: Activation lot-contract regression

**Files:**
- Modify: `scripts/phase7c-lot-settings.test.mjs`
- Modify after RED only: `scripts/activate-phase7c-local.ps1`

**Interfaces:**
- Consumes: `TrendFixedVolume`, `SidewayMaxLot` arguments passed by `activate-phase7c-safe-local.ps1`.
- Produces: fail-closed activation validation consistent with the already-merged canonical lot contract.

- [ ] **Step 1: Write the failing test**

Add a source-contract test asserting that base activation caps Trend at `0.06`, Sideway max at `0.04`, validates Trend with `/ 0.03`, validates Sideway cap with `/ 0.01`, and does not route Sideway max through the Trend managed-lot validator.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @xauusd/api... build && node --test scripts/phase7c-lot-settings.test.mjs`

Expected: the new activation regression fails because current `activate-phase7c-local.ps1` still accepts `0.30` and validates `SidewayMaxLot` through the shared `0.03` managed-lot increment.

- [ ] **Step 3: Write minimal implementation**

In `scripts/activate-phase7c-local.ps1`, replace the shared `Assert-ManagedLot` behavior with separate Trend executed-lot and Sideway cap validation. Do not change activation lifecycle, task handoff, PAUSE behavior, or order permissions.

- [ ] **Step 4: Run focused verification**

Run API build, `node --test scripts/phase7c-lot-settings.test.mjs`, Node syntax checks used by the workflow, and PowerShell parser checks for the modified activation script.

Expected: PASS with no warnings/errors attributable to the change.

- [ ] **Step 5: Full CI and integration**

Push the GREEN implementation, run the repository's full PR CI matrix, review the final diff, and merge only if all required checks are green and the PR head remains the verified SHA.
