# Phase7C Additive Fixed TP Implementation Plan

Date: 2026-09-01
Design: `docs/superpowers/specs/2026-09-01-phase7c-autolot-fixed-tp-design.md`
Approved design SHA: `b13cb7d012d3b5331f8f34a141c1d3530a5f0c85`
Implementation branch: `feat/phase7c-fixed-tp-additive`
Scope: `PHASE7C_FIXED_TP_ADDITIVE_FULL_CLOSE`
Runtime mutation: NONE

## Goal

Add an independently configurable, executor-owned fixed take-profit hard exit for Trend and Sideway without changing current behavior by default. Fixed TP is disabled after v1 migration, applies only to positions created after the setting snapshot, uses executable close-side quotes, never overwrites broker/native TP, and closes exactly the full remaining managed volume through deterministic idempotency plus the existing shared execution lock.

Trend AutoRisk is explicitly out of scope for this plan and must remain production-equivalent to the current fixed-lot Trend behavior.

## Architecture

1. Upgrade the durable Phase7C management/settings model from v1 to backward-compatible v2. Migrate v1 in memory with `trendFixedTpEnabled=false`, `trendFixedTpDistance=0`, `sidewayFixedTpEnabled=false`, `sidewayFixedTpDistance=0` while preserving all current lot values.
2. Extend `/api/v1/phase7c/lot-settings` and the existing PAUSE + matching account + healthy bridge + zero-XAUUSD-position save guard with the four Fixed TP fields. Reject enabled non-finite/non-positive distances; disabled zero is valid. Do not apply broker stops-level validation because Fixed TP is executor-owned.
3. Upgrade PowerShell risk-profile/runtime settings validation and active-settings materialization so configured/active/restart-required comparison includes Fixed TP while remaining backward compatible with v1 account profiles.
4. Pass strategy-specific Fixed TP enable/distance values through the existing canonical executor supervisor/launchers into Trend and Sideway. Do not introduce a parallel settings path.
5. Add a small pure module, `scripts/phase7c-fixed-tp.mjs`, for target construction, executable-price trigger evaluation, deterministic command identity, and normalized snapshot creation. Keep it broker-I/O free so the core contract is unit-testable.
6. Snapshot Fixed TP configuration into Trend and Sideway pending-entry state before broker submission and copy it into managed state on fill/recovery. Existing managed positions that predate schema v2 restore with Fixed TP disabled; later Web/API edits must not mutate them.
7. In each strategy `managePosition`, reconcile the managed broker position first, then evaluate Fixed TP against BUY bid / SELL ask. Native BE, partial, trailing, Sideway TP2, time/reversal/regime exits and Daily Recovery remain unchanged unless the Fixed TP close has already won naturally.
8. On Fixed TP trigger, revalidate ticket/side/current remaining volume, acquire `scripts/phase7c-execution-lock.mjs` immediately before the mutating close, and fail closed if the lock cannot be acquired. Release the lock in `finally`.
9. Use one deterministic close command identity per managed Fixed TP action: `phase7c-fixed-tp-{strategy}-{ticket}`. Never include an attempt counter or timestamp. Repeated cycles/recovery may replay the same command identity but must not create a second broker mutation.
10. Submit `volume=position.volume` for the Fixed TP close. Do not write or patch broker `takeProfit`; Daily Recovery/Sideway broker TP stays intact.
11. Journal explicit Fixed TP observability events: `FIXED_TP_CONFIG_SNAPSHOT`, `FIXED_TP_TRIGGERED`, `FIXED_TP_CLOSE_ATTEMPT`, `FIXED_TP_CLOSE_CONFIRMED`, `FIXED_TP_CLOSE_REPLAY`, `FIXED_TP_CLOSE_BLOCKED`.
12. Extend Web types/API/control-center form with independent Trend and Sideway Fixed TP enable/distance controls, configured/active/restart-required visibility and the existing `NEW_POSITIONS_ONLY` notice. The settings UI remains configuration-only; no direct order/close button is added.
13. Add a focused Linux + Windows CI workflow and run the existing lot/settings, account-mode, Trend singleton, Sideway, structural-SL and Web/API build regressions before PR.

## Task 1 — Lock schema-v2 migration and pure Fixed TP contract in RED

**Files:**
- Create: `scripts/phase7c-fixed-tp.test.mjs`
- Modify: `scripts/phase7c-lot-settings.test.mjs`
- Create: `.github/workflows/phase7c-fixed-tp-additive-ci.yml`

**RED assertions:**
- v1 settings migrate to v2 without changing `trendFixedLot`, `sidewayRiskPercent` or `sidewayMaxLot`.
- v1 migration defaults both Fixed TP features OFF with distance 0.
- independent Trend/Sideway enabled distances validate and persist.
- enabled distance `<= 0`, NaN or infinity is rejected; disabled distance 0 is valid.
- pure BUY target is `entry + distance`; SELL target is `entry - distance`.
- BUY trigger uses bid only; SELL trigger uses ask only.
- disabled Fixed TP never triggers.
- deterministic command id is stable and exactly strategy + ticket scoped.

Run focused tests and prove failure is caused only by missing schema-v2/helper production support.

Commit: `test: define additive fixed TP contract`

## Task 2 — Minimal settings-v2 and pure helper GREEN

**Files:**
- Create: `scripts/phase7c-fixed-tp.mjs`
- Modify: `apps/api/src/services/phase7c-lot-settings.service.ts`
- Modify: `scripts/lib/phase7c-account-mode.ps1`
- Modify tests from Task 1 only as needed for fixture compatibility, not to weaken assertions.

**Implementation:**
- Export pure helper functions for normalized snapshot, target, trigger and command id.
- Add v1 -> v2 migration in the canonical settings service.
- Keep default behavior equivalent: Fixed TP OFF/0.
- Make PowerShell risk-profile validation accept legacy v1 and canonicalize to v2 while preserving existing LIVE profile binding safeguards.

Run focused tests until GREEN.

Commit: `feat: add fixed TP settings v2 contract`

## Task 3 — Runtime settings wiring RED then GREEN

**Files:**
- Modify: `scripts/run-phase7c-executors-local.ps1`
- Modify exact Trend launch wrappers after source verification.
- Modify exact Sideway launch wrappers after source verification.
- Add/extend focused source-contract tests.

**RED contract:**
- active runtime settings contain the four Fixed TP fields.
- configured-vs-active drift includes Fixed TP changes so restart-required becomes true.
- Trend receives only Trend Fixed TP settings; Sideway receives only Sideway Fixed TP settings.
- no AutoRisk production parameters are introduced in this PR.

**GREEN implementation:**
- read canonical v2 settings through the existing supervisor path.
- pass enable/distance as environment/launcher inputs to the matching strategy.
- preserve all current account-mode, ARM and startup PAUSE safety semantics.

Commit: `feat: wire fixed TP runtime settings`

## Task 4 — Trend snapshot/recovery RED then GREEN

**Files:**
- Modify: `scripts/run-phase7b-demo-controller.ts`
- Add/extend Trend focused synthetic tests.

**RED contract:**
- pending entry stores `fixedTpEnabled`, `fixedTpDistance` and entry-derived `fixedTpPrice` before broker submission.
- managed state inherits the same immutable snapshot on fill/recovery.
- old persisted state without Fixed TP fields restores with feature disabled.
- later settings changes cannot alter an existing managed snapshot.
- Daily Recovery `takeProfit` payload remains unchanged.

**GREEN implementation:**
- snapshot configuration at pending-entry creation.
- derive target from actual managed entry price at fill/recovery when needed; round only for price precision/logging.
- retain current Trend fixed-lot sizing and all existing entry/SL/TP behavior.

Commit: `feat: snapshot Trend fixed TP state`

## Task 5 — Trend Fixed TP full-close RED then GREEN

**Files:**
- Modify: `scripts/run-phase7b-demo-controller.ts`
- Reuse: `scripts/phase7c-execution-lock.mjs`
- Reuse: `scripts/phase7c-fixed-tp.mjs`
- Add/extend Trend synthetic tests.

**RED contract:**
- BUY triggers only when bid reaches target; SELL only when ask reaches target.
- below +6 may close full volume before BE.
- between +6 and +10 preserves prior BE when BE happened first, then full closes before partial.
- above +10 allows existing one-third partial first, then closes all remaining volume.
- Fixed TP close uses `volume=position.volume`.
- Fixed TP uses deterministic `phase7c-fixed-tp-trend-{ticket}` command id, independent of retries.
- execution-lock contention produces `FIXED_TP_CLOSE_BLOCKED` and sends no close mutation.
- confirmed/replay close emits distinct Fixed TP journal events and returns before further management.
- existing reversal/runner/full-close command identities remain untouched.

**GREEN implementation:**
- add the Fixed TP hard-exit check to managed-position flow without rewriting existing management functions.
- acquire/release shared execution lock only around the Fixed TP mutating close.
- preserve native broker TP and structural SL behavior.

Commit: `feat: enforce Trend additive fixed TP exit`

## Task 6 — Sideway snapshot/recovery RED then GREEN

**Files:**
- Modify: `scripts/run-phase7c-sideway-controller.mjs`
- Add/extend Sideway focused synthetic tests.

**RED contract:**
- pending/managed Sideway state persists the immutable Fixed TP snapshot.
- restart restores the same target.
- old state migrates with Fixed TP disabled.
- existing Sideway broker TP2 and Daily Recovery TP are not overwritten.

**GREEN implementation:**
- snapshot only Sideway Fixed TP settings at entry creation/fill/recovery.
- leave current Sideway AutoLot capital-base/sizing semantics untouched.

Commit: `feat: snapshot Sideway fixed TP state`

## Task 7 — Sideway Fixed TP full-close RED then GREEN

**Files:**
- Modify: `scripts/run-phase7c-sideway-controller.mjs`
- Reuse: `scripts/phase7c-execution-lock.mjs`
- Reuse: `scripts/phase7c-fixed-tp.mjs`
- Add/extend Sideway synthetic tests.

**RED contract:**
- executable BUY bid / SELL ask triggers.
- +6/+10 behavior remains natural before later targets.
- TP2/range/time/regime exits remain unchanged and whichever closes first wins.
- Fixed TP full closes current remaining volume with deterministic `phase7c-fixed-tp-sideway-{ticket}` command id.
- lock contention blocks the close without a broker mutation.
- duplicate polling/restart replays the same command identity.

Commit: `feat: enforce Sideway additive fixed TP exit`

## Task 8 — API and Web controls RED then GREEN

**Files:**
- Modify: `apps/api/src/routes/phase7c.route.ts`
- Modify: `apps/web/src/phase7c-types.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/pages/Phase7CControlCenterPage.tsx`
- Add/extend API/Web source-contract tests.

**RED contract:**
- API round-trips independent Trend/Sideway Fixed TP fields.
- save guard remains PAUSE + valid account + matching healthy bridge + zero XAUUSD positions.
- invalid enabled distances return validation error.
- Web sends both strategy controls through the existing single settings mutation transport.
- Web shows configured and active Fixed TP values, restart-required and `NEW_POSITIONS_ONLY`.
- no direct order/position mutation is introduced from settings UI.

**GREEN implementation:**
- extend the existing lot/settings panel instead of creating a second settings subsystem.
- preserve all lifecycle/AUTO provenance and account safety semantics.

Commit: `feat: expose additive fixed TP controls`

## Task 9 — Focused GREEN and full regression verification

Run at minimum:

```text
node scripts/phase7c-fixed-tp.test.mjs
node scripts/phase7c-lot-settings.test.mjs
pnpm --filter @xauusd/api build
pnpm --filter @xauusd/web build
```

Then require green GitHub Actions for the new focused workflow plus relevant existing workflows:

```text
phase7c-fixed-tp-additive-ci
phase7c-lot-range-120-ci
phase7c-web-lot-canonical-ui-ci
phase7c-live-risk-profile-ci
phase7c-dual-account-mode-ci
phase7c-sideway-regime-ci
phase7c-structural-sl-full-ci
phase7c-structural-sl-monotonicity-ci
phase7c-trend-singleton-ownership-ci
phase7c-web-live-arm-demo-auto-ci
```

If any existing regression fails, diagnose before weakening the Fixed TP contract.

## Task 10 — PR / merge checkpoint only

Create a PR containing only Fixed TP additive implementation. Verify exact changed files, focused and full CI, and expected head SHA before merge.

Do not deploy after merge in this implementation scope. Production deployment requires a separate explicit operator approval and fresh runtime verification with zero XAUUSD positions/pending orders, controlled PAUSE -> executor restart -> verification -> AUTO restore, and no LIVE test order.

## Acceptance checkpoint

```text
FIXED_TP_DEFAULT=OFF
V1_MIGRATION=PRODUCTION_EQUIVALENT
TREND_FIXED_TP=INDEPENDENT
SIDEWAY_FIXED_TP=INDEPENDENT
BUY_TRIGGER=BID
SELL_TRIGGER=ASK
BROKER_TP_OVERWRITE=NONE
FULL_CLOSE=REMAINING_VOLUME_100_PERCENT
COMMAND_ID=DETERMINISTIC_STRATEGY_PLUS_TICKET
EXECUTION_LOCK=REQUIRED_FAIL_CLOSED
NEW_POSITIONS_ONLY=TRUE
TREND_AUTORISK_CHANGE=NONE
LIVE_RUNTIME_MUTATION=NONE
LIVE_TEST_ORDER=NONE
```
