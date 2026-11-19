# Phase7C AutoLot + Fixed TP Design

Date: 2026-09-01
Status: Approved in-chat design; source-only specification
Scope: Phase7C Trend AutoLot + additive Trend/Sideway fixed-TP management
Runtime mutation: NONE

## 1. Goals

Add two independently configurable capabilities without removing or redefining any current trading behavior:

1. Add canonical AutoLot support to Trend while preserving Trend fixed-lot mode as the default and preserving Sideway's current AutoLot behavior.
2. Add an optional fixed take-profit hard-exit for Trend and Sideway. The operator enters the fixed TP distance separately for each strategy. When that target is reached, the bot closes 100% of the remaining managed position.

All existing entry rules, initial SL rules, +6 break-even, +10 one-third partial close, Trend structural runner/trailing, Sideway range management/TP2, timeout behavior, daily recovery, account guards, execution locking, idempotency and crash recovery remain intact unless a valid existing exit or the newly enabled fixed-TP target closes the position first.

## 2. Non-goals

- No martingale.
- No recovery lot escalation.
- No signal-quality-based lot escalation.
- No change to entry criteria, regime selection or strategy-condition semantics.
- No mutation of existing/open positions when settings are changed.
- No removal of Trend fixed-lot mode.
- No removal or replacement of Sideway's existing AutoLot behavior.
- No change to Sideway's existing balance-based AutoLot capital-base semantics in this scope.
- No replacement of native Daily Recovery TP logic.
- No direct broker-order mutation from the Web/API preview path.

## 3. Runtime safety contract

All configuration changes are fail-closed and apply to NEW_POSITIONS_ONLY.

Changing lot or fixed-TP settings requires:

- bot mode PAUSE;
- valid configured account mode;
- healthy matching MT5 bridge;
- zero open XAUUSD positions;
- canonical settings validation;
- executor restart only when active runtime configuration differs from persisted configuration.

The configuration UI/API never sends an order, closes a position or modifies an existing position directly.

## 4. Settings model

Upgrade the durable Phase7C lot/management settings schema to a backward-compatible new version. Existing v1 files must migrate in memory to safe defaults.

Proposed canonical fields:

```text
version: 2

trendLotMode: FIXED | AUTO_RISK
trendFixedLot: number
trendRiskPercent: number
trendMaxLot: number

sidewayRiskPercent: number
sidewayMaxLot: number

trendFixedTpEnabled: boolean
trendFixedTpDistance: number

sidewayFixedTpEnabled: boolean
sidewayFixedTpDistance: number
```

Safe migration defaults from v1:

```text
trendLotMode = FIXED
trendFixedLot = existing trendFixedLot
trendRiskPercent = 0.25
trendMaxLot = existing trendFixedLot
sidewayRiskPercent = existing sidewayRiskPercent
sidewayMaxLot = existing sidewayMaxLot
trendFixedTpEnabled = false
trendFixedTpDistance = 0
sidewayFixedTpEnabled = false
sidewayFixedTpDistance = 0
```

Migration must preserve current production behavior exactly until the operator explicitly enables a new feature.

## 5. Canonical AutoLot sizing

### 5.1 Trend AUTO_RISK capital base

For the new Trend `AUTO_RISK` mode only, use the conservative account base approved in the design discussion:

```text
capitalBase = min(accountBalance, accountEquity)
```

If balance/equity is missing, non-finite or <= 0, Trend AutoLot sizing fails closed and the entry is blocked.

Sideway does not adopt this capital-base change in this scope; its existing capital-base semantics remain unchanged.

### 5.2 Trend AUTO_RISK calculation

For a validated Trend stop distance:

```text
targetRiskUsd = capitalBase * trendRiskPercent / 100
oneLotRiskUsd = stopDistance * cashPerPriceUnitPerLot
rawLot = targetRiskUsd / oneLotRiskUsd
cap = min(rawLot, trendMaxLot, brokerMaxVolume)
```

The final lot must use the existing canonical compatibility rule for exact one-third management:

- align to broker volumeStep;
- be >= broker minVolume;
- preserve an exact one-third partial close;
- remain within the configured Trend cap and broker maximum;
- round down, never up, relative to the risk cap.

If no compatible lot exists, block the entry instead of forcing broker minimum volume.

### 5.3 Trend modes

Trend supports two explicit modes:

`FIXED`
- Existing Trend behavior.
- Uses `trendFixedLot` unchanged.
- This is the migration/default mode.

`AUTO_RISK`
- Uses `trendRiskPercent` and `trendMaxLot`.
- Fetches a fresh canonical risk snapshot at the final entry gate.
- Revalidates account identity, account mode, broker symbol, stop distance, risk inputs and snapshot freshness before submitting the order.
- Captures the selected volume durably in pending-entry state before broker submission, preserving crash recovery semantics.

### 5.4 Sideway

Sideway retains its current AutoLot flow, current capital-base semantics and final-gate validation.

The implementation may reuse pure helpers for broker-step and exact-one-third compatibility, but must not silently change Sideway's existing risk-base calculation in this scope.

Existing `sidewayRiskPercent` and `sidewayMaxLot` remain operator-configurable.

## 6. Fixed TP semantics

### 6.1 Independent additive feature

Fixed TP is an optional management rule per strategy. It does not replace native position management.

Configuration:

```text
Trend:   enabled + distance entered by operator
Sideway: enabled + distance entered by operator
```

The distance is expressed in XAUUSD price units ("giá"), measured from the actual managed entry price.

For BUY:

```text
fixedTpPrice = entry + fixedTpDistance
```

For SELL:

```text
fixedTpPrice = entry - fixedTpDistance
```

### 6.2 Executor-owned hard exit

Fixed TP is implemented as an executor-owned hard-exit condition rather than overwriting the broker `takeProfit` field.

Reason: Sideway and Daily Recovery already use broker/native TP semantics. MT5 positions expose one take-profit price, so writing the new fixed TP into that field would replace existing behavior. An executor-owned trigger lets all existing functions remain intact.

Trigger price uses an executable close-side quote:

- BUY/LONG: trigger when bid >= fixedTpPrice.
- SELL/SHORT: trigger when ask <= fixedTpPrice.

On trigger:

1. Reconcile managed state with broker position.
2. Revalidate ticket, side, remaining volume, account identity and execution guards.
3. Acquire the existing shared execution lock.
4. Submit exactly one idempotent full-close command for the remaining managed volume.
5. Persist/journal the attempt and terminal result.
6. Do not submit further management actions after the position is confirmed closed.

### 6.3 Interaction with existing management

All native management remains active until the position is closed.

Fixed TP above +10:

```text
Entry
+6  -> existing BE behavior
+10 -> existing one-third partial behavior
... -> existing Trend trailing / Sideway management continues
Fixed TP -> close 100% of remaining volume
```

Fixed TP below +10:

```text
Entry
+6 -> existing BE if price reaches +6 first
Fixed TP -> close 100% of remaining volume
```

If the operator configures Fixed TP below +6, the full-close target may be reached before break-even. This is intentional: no existing rule is disabled; the position simply no longer exists after the valid full-close exit.

If a native exit, Sideway TP2, reversal exit, timeout, stop loss, or broker-side Daily Recovery TP closes the position before the fixed target, the fixed-TP rule becomes a no-op after reconciliation.

There is no synthetic priority that suppresses an existing exit. Whichever valid exit closes the position first wins naturally.

## 7. Daily Recovery interaction

Daily Recovery remains unchanged.

When Daily Recovery places an adaptive broker TP, the new fixed TP does not overwrite it. The executor continues monitoring the operator fixed target independently.

Therefore:

- if the recovery TP is reached first, broker closes the position and reconciliation clears managed state;
- if the operator fixed TP is reached first, the executor closes all remaining volume;
- no lot escalation is introduced;
- Daily Recovery accounting and target calculations remain unchanged.

## 8. NEW_POSITIONS_ONLY snapshot contract

Both lot mode and fixed TP settings are snapshotted into pending/managed state at entry creation.

Proposed additional state fields:

```text
lotMode
configuredRiskPercent
configuredMaxLot
selectedVolume

fixedTpEnabled
fixedTpDistance
fixedTpPrice
fixedTpAttempt
```

Once a position exists, later Web/API settings changes must not change its fixed target, selected lot, stop, or management semantics.

Restart/crash recovery restores the persisted snapshot and continues managing the existing position under the entry-time contract.

## 9. Fixed TP validation

When enabled, distance must be:

- finite;
- > 0;
- converted to an absolute target using the managed entry price;
- rounded only to the broker symbol price precision for comparison/logging.

Because this feature is an executor-owned close trigger and does not place a broker TP order, broker `stopsLevel`/TP-distance validation must not be incorrectly applied to the configured distance.

A disabled fixed TP stores no active target and must not alter order/management payloads.

The API rejects invalid values instead of silently clamping them.

## 10. Web/API behavior

Expose separate controls for Trend and Sideway.

Trend section:

```text
Lot mode: Fixed | Auto Risk
Fixed lot
Risk %
Max Auto Lot
Fixed TP: On/Off
Fixed TP distance
```

Sideway section:

```text
Risk %
Max Auto Lot
Fixed TP: On/Off
Fixed TP distance
```

The Web UI must display:

- configured values;
- active runtime values;
- whether restart is required;
- `NEW_POSITIONS_ONLY` notice;
- calculated Trend AutoLot preview for representative/actual stop distance;
- existing Sideway AutoLot preview unchanged;
- fixed TP preview price when an entry reference is available;
- no order-action button in the settings panel.

Saving remains restricted to PAUSE + zero XAUUSD positions using the existing settings safety contract.

## 11. Observability and journal events

Add explicit events so fixed TP cannot be confused with native exits:

```text
FIXED_TP_CONFIG_SNAPSHOT
FIXED_TP_TRIGGERED
FIXED_TP_CLOSE_ATTEMPT
FIXED_TP_CLOSE_CONFIRMED
FIXED_TP_CLOSE_REPLAY
FIXED_TP_CLOSE_BLOCKED
```

Trend AutoLot events identify mode, target risk, raw lot, capped lot, final compatible lot, estimated risk USD/percent and block reason.

Never log secret values.

## 12. Idempotency and concurrency

Fixed TP full-close uses the same execution ownership discipline as other mutating management actions.

A deterministic idempotency key must be derived from the managed ticket/position identity and fixed-TP action, conceptually:

```text
phase7c-fixed-tp-{strategy}-{ticket}
```

Repeated cycles, API retries or process recovery may replay the same action but must not create multiple close mutations.

Trend single-writer ownership and the shared execution lock remain mandatory and unchanged.

## 13. Testing contract

Implementation follows RED -> minimal fix -> GREEN -> full CI.

### 13.1 Trend AutoLot

Required regression coverage:

- v1 settings migrate without changing current production behavior.
- Trend FIXED remains equivalent in sizing semantics.
- Trend AUTO_RISK calculates from `min(balance,equity)`.
- Trend AutoLot rounds down and never exceeds target risk/cap.
- exact one-third compatible lots only.
- below-compatible-minimum blocks instead of forcing a lot.
- stale/mismatched risk snapshots fail closed.
- Sideway current AutoLot regressions remain green with no capital-base semantic change.

### 13.2 Fixed TP

Required regression coverage:

- disabled mode produces no behavioral mutation.
- separate Trend and Sideway distances.
- BUY triggers from bid; SELL triggers from ask.
- fixed TP below +6 may close full position before BE if reached first.
- fixed TP between +6 and +10 preserves BE then closes full position before partial.
- fixed TP above +10 allows existing one-third partial, then closes all remaining volume at target.
- Trend structural trailing remains unchanged until fixed TP closes the position.
- Sideway TP2/range management remains unchanged until whichever exit closes first.
- Daily Recovery broker TP is not overwritten.
- settings changes never mutate an existing position.
- restart restores the entry-time fixed-TP snapshot.
- duplicate polling/retry performs one idempotent close mutation.
- execution-lock contention fails closed.

### 13.3 Integration

- API build.
- Web build.
- Trend controller parse/runtime tests.
- Sideway controller regressions.
- lifecycle/settings safety tests.
- account-mode LIVE/DEMO guards.
- existing singleton ownership regression.
- existing structural SL monotonicity and partial-management regressions.

### 13.4 Implementation decomposition

Treat the two capabilities as separate implementation scopes and separate PRs to minimize trading-risk coupling:

1. `PHASE7C_FIXED_TP_ADDITIVE_FULL_CLOSE`
   - settings migration/controls required by fixed TP;
   - Trend + Sideway managed-state snapshots;
   - executor-owned idempotent full-close trigger;
   - Web/API controls and observability;
   - no AutoLot production change in this PR.

2. `PHASE7C_TREND_AUTO_RISK`
   - Trend `FIXED | AUTO_RISK` mode;
   - conservative `min(balance,equity)` sizing for Trend AUTO_RISK;
   - canonical compatibility/freshness guards;
   - Sideway AutoLot behavior remains unchanged.

Each scope must independently complete RED -> minimal fix -> GREEN -> full CI -> PR -> merge before any production deployment decision.

## 14. Deployment contract

Development and CI are source-only.

No LIVE deploy until:

- the relevant implementation PR is merged;
- all required CI is green;
- current runtime has zero XAUUSD positions/pending orders;
- operator explicitly approves deployment;
- controlled PAUSE -> executor restart -> runtime verification -> AUTO restore is used;
- no LIVE test order is sent.

## 15. Acceptance criteria

The complete feature set is accepted when all of the following are true:

1. Current production behavior is unchanged with migrated/default settings.
2. Trend can independently select FIXED or AUTO_RISK sizing.
3. Sideway existing AutoLot behavior remains unchanged in capital-base semantics and canonical in its existing execution path.
4. Trend and Sideway each have independently operator-entered fixed TP enable/distance settings.
5. Fixed TP closes 100% of the remaining position when its target is reached.
6. Fixed TP does not overwrite native Sideway/Daily Recovery broker TP behavior.
7. +6 BE, +10 one-third, Trend trailing/runner, Sideway management and all existing exits remain active unless the position has already been closed.
8. Settings changes are NEW_POSITIONS_ONLY.
9. Close retries are idempotent and execution-lock protected.
10. No source-development step mutates the running LIVE bot.
