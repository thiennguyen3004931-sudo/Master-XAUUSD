# SEMI Auto — Manual Entry + Trend Management Design

Date: 2026-09-09
Status: Approved in-chat design; written specification pending operator review
Repository: `thiennguyen3004931-sudo/xauusd-ai-master`
Target base: `main` at `cc6cda43bda75dbf027530bdd91f9c98604b4a66`

## 1. Purpose

Add a distinct `SEMI` / **BÁN TỰ ĐỘNG** operating mode for XAUUSD.

In SEMI mode, the operator decides the entry manually in MT5. The bot must never create the entry order. After an eligible manual XAUUSD position is opened, the runtime adopts exactly that position and manages it with the existing Trend position-management rules.

The design goal is deliberately narrow:

- manual BUY/SELL and manual entry timing;
- automatic protection and exit management after adoption;
- reuse the canonical Trend management engine rather than create a second management engine;
- keep AUTO, PAUSE, Sideway, lifecycle, account safety and execution ownership fail-closed;
- expose truthful management telemetry to Signal UI V3 without inventing state.

## 2. Non-goals

SEMI does not:

- add another entry strategy;
- score or approve the operator's manual entry;
- require Trend/Sideway regime approval before adopting a manual entry;
- allow the bot to create a new position while SEMI is active;
- apply Daily Recovery TP to manual positions;
- infer a manual position from an arbitrary unmanaged or EA-owned position;
- change Sideway management rules;
- weaken account, LIVE-arm, source, singleton, lifecycle or execution-lock safety;
- create a LIVE validation order during implementation or rollout.

## 3. Existing behavior to reuse

The existing Trend controller already contains the desired post-entry behavior:

- initial Trend stop distance has a 6-price minimum and 10-price maximum for algorithmic entries;
- at +6 favorable price units, move Stop Loss to Entry / break-even;
- at +10 favorable price units, close one third when broker volume constraints allow it;
- FastMove activates from +10 favorable price units and uses a 6-price giveback lock;
- subsequent structural Stop Loss uses confirmed M15 structure and only tightens;
- Fixed TP is an additive Trend feature and is reconciled to the broker when enabled;
- hold/reversal/exit logic already runs inside the Trend management path;
- stop monotonicity helpers already prevent loosening;
- execution lock and singleton ownership already exist.

Today, a position that is present while there is no canonical `managed` or `pendingEntry` state is journaled as `UNMANAGED_POSITION_PRESENT` and ignored. SEMI adds a tightly guarded adoption path at that boundary.

## 4. Canonical mode semantics

`SEMI` is a first-class mode. It must not be represented as PAUSE or overloaded onto AUTO.

| Mode | Algorithmic new entry | New manual adoption | Existing owned-position management |
| --- | --- | --- | --- |
| `PAUSE` | Blocked | Blocked | Continues protective management |
| `SEMI` | Blocked | Enabled for one eligible manual XAUUSD position | Continues |
| `AUTO` | Enabled subject to canonical strategy gates | Blocked | Continues |
| `TREND` / `SIDEWAY` if retained as explicit operator modes | Existing behavior | Blocked | Continues |

The mode controls **acquisition of a new position**, not whether an already-owned position receives protective management.

Consequences:

1. `SEMI` must never POST `/v1/orders` for a new entry.
2. Switching `SEMI -> AUTO` while an adopted manual ticket is still open must not abandon management.
3. While any owned XAUUSD ticket is open, AUTO entry remains blocked by the existing single-position / execution ownership rules.
4. Switching to PAUSE must block new entries/adoptions, but must not intentionally disable protective management of an already-owned position.

## 5. SEMI activation provenance

The canonical bot-mode state must persist enough provenance to establish when SEMI became active.

Required semantic fields or equivalent canonical data:

- current mode;
- mode version / monotonic revision where available;
- mode changed-at timestamp;
- change source / actor provenance according to the existing bot-mode model.

A manual position is eligible for adoption only if its broker `openedAt` is at or after the current SEMI activation timestamp. Positions that existed before SEMI was enabled must not be silently adopted.

If the runtime cannot prove the activation boundary, adoption fails closed.

## 6. Manual-position provenance and eligibility

A position must satisfy **all** of the following before adoption:

1. Symbol resolves canonically to XAUUSD.
2. Account/login is the currently accepted runtime account.
3. The position was opened at or after the current SEMI activation boundary.
4. Broker provenance identifies it as a manual position, not a bot/EA/validation position.
5. It is not the position for a durable bot `pendingEntry`.
6. It is not already owned by another managed state.
7. There is exactly one eligible candidate and no ambiguous additional XAUUSD position.
8. Side, entry price, volume, ticket and opened-at timestamp are valid finite broker values.
9. The runtime is in `SEMI` at the acquisition decision point.
10. Account, source, lifecycle and execution ownership guards are healthy enough to perform protective mutations.

### 6.1 Required broker telemetry

The current position model must expose sufficient read-only provenance to distinguish a true manual position. Prefer broker-native fields such as:

- `magic` / magic number;
- `comment`;
- any native trade reason/origin field if the bridge exposes one reliably.

A canonical manual candidate is normally `magic == 0` plus compatible broker origin semantics. Existing bot magic numbers and validation/test markers must be explicitly excluded.

If the bridge does not currently expose the necessary fields, implementation must first extend the read-only position telemetry. SEMI must not adopt based solely on “there is an unmanaged position”.

### 6.2 Ambiguity policy

If multiple candidates, mixed ownership, missing provenance, conflicting account identity, or any unresolved ownership condition exists:

- do not adopt;
- do not open or close an order;
- do not change an unrelated position;
- emit a structured `SEMI_ADOPTION_BLOCKED` reason;
- expose the block through semantic/runtime observability.

## 7. Shared acquisition lock and protection-first ownership

Manual adoption must use the same shared execution/ownership serialization used by algorithmic entry.

The adoption decision sequence is:

1. observe candidate read-only;
2. acquire shared execution lock with a SEMI-specific owner;
3. re-read mode, account identity and open XAUUSD positions under the lock;
4. re-validate manual provenance and uniqueness;
5. create **provisional durable ownership** for the exact ticket with `protectionStatus=PENDING`;
6. reconcile the canonical initial 6-price protection;
7. on success, persist `protectionStatus=PROTECTED` and enable normal Trend management;
8. on broker/legal failure, persist `protectionStatus=PROTECTION_BLOCKED` and restrict the runtime to protection reconciliation, exact-ticket monitoring and manual-close detection until protection is restored;
9. release the lock.

The provisional durable record prevents duplicate adoption across crashes/restarts while still making the protection state truthful. A `PENDING` or `PROTECTION_BLOCKED` ticket is owned only for safety and reconciliation; it must not run normal BE/partial/FastMove/structural/Fixed-TP mutations until canonical protection is present.

This prevents AUTO/Trend/Sideway entry and SEMI adoption from racing during mode transitions or concurrent cycles, and prevents the UI from claiming normal Trend management before the position is protected.

## 8. Durable managed-state model

The durable Trend state should evolve so manual ownership is explicit rather than faked as an algorithmic pattern.

Recommended state version: `3`.

Existing version-2 managed state migrates as:

- `entrySource = SYSTEM`;
- `managementStrategy = TREND` for existing Trend state;
- algorithmic signal/pattern fields retain their current meaning;
- `protectionStatus = PROTECTED` for existing states whose current exact-ticket stop state passes reconciliation; otherwise the runtime enters the same explicit protection-reconciliation path before normal mutations resume.

Manual adopted state includes at minimum:

- `ticket`;
- `entrySource = MANUAL`;
- `managementStrategy = TREND`;
- `entry` = actual broker fill;
- `side` = actual broker side;
- `initialVolume` = actual volume at adoption;
- `expectedRemainingVolume`;
- `manualOpenedAt`;
- `managementStartedAt`;
- `initialStopDistance = 6`;
- `protectionStatus = PENDING | PROTECTED | PROTECTION_BLOCKED`;
- Fixed TP snapshot fields from the active Trend Fixed TP configuration;
- break-even, partial, FastMove and trailing state fields reused from Trend management;
- account/login binding;
- no fabricated candle pattern or signal approval.

Signal-specific fields that do not exist for a manual position must be nullable/optional or moved under a system-entry context. A manual position must not be labeled with a fake `ENGULFING`, `TWO_CANDLE`, `THREE_CANDLE`, or equivalent pattern.

Daily Recovery fields for `entrySource=MANUAL` are disabled/empty and must not affect exit behavior.

On restart, the runtime reloads the durable manual managed state and reconciles it against the exact broker ticket/account before resuming management. It must never “rediscover” a different manual position as the old ticket. If protection state is `PENDING` or `PROTECTION_BLOCKED`, restart resumes protection reconciliation first.

## 9. Initial Stop Loss policy

For a manual SEMI position, the canonical initial risk stop is exactly 6 price units from the actual broker entry:

- BUY: `entry - 6`;
- SELL: `entry + 6`.

This differs intentionally from algorithmic Trend entry, which derives an initial stop from structure with a 6-price minimum and 10-price maximum. SEMI always starts from the operator-approved fixed 6-price default.

### 9.1 Never loosen protection

Adoption compares the current broker SL with the canonical 6-price stop.

- No SL: attempt to set the canonical 6-price stop.
- Existing SL is wider / less protective: tighten to the canonical 6-price stop.
- Existing SL is equal: no mutation.
- Existing SL is tighter / more protective: preserve it.

After adoption, every bot-driven stop change remains monotonic. The bot never widens a stop merely to restore a nominal rule.

If the operator later manually tightens the SL, the runtime accepts that tighter broker state as the new protection baseline.

If the operator later loosens or removes the SL, the runtime restores the tightest canonical protection level known for that ticket, subject to broker legality. It never intentionally restores a weaker stop.

### 9.2 Broker stop/freeze edge case

If the canonical 6-price stop cannot legally be placed at adoption because of broker stop/freeze/current-market constraints, and the position does not already have an equally-or-more-protective valid SL:

- keep the exact ticket in provisional durable ownership;
- set `protectionStatus=PROTECTION_BLOCKED`;
- do not silently widen the SL beyond the 6-price risk limit;
- do not force-close the position as part of this feature;
- expose an operator-visible safety alert;
- do not perform normal Trend management mutations while protection is blocked;
- retry only the canonical/tighter protection reconciliation on later guarded cycles;
- allow exact-ticket disappearance/manual close to clear the blocked ownership safely.

The invariant is explicit: **the UI must never claim normal Trend management unless `protectionStatus=PROTECTED`; otherwise it must show `PENDING` or `PROTECTION_BLOCKED`.**

## 10. Fixed TP

SEMI uses the **same current Trend Fixed TP configuration**.

- If Trend Fixed TP is enabled, calculate the canonical target from the actual broker fill and the configured Trend distance, then reconcile the broker TP to that exact target using the existing Trend Fixed TP semantics. A manually supplied different TP is not a separate SEMI override while Fixed TP is enabled.
- If Trend Fixed TP is disabled, SEMI does not invent, place or normalize a Fixed TP merely because the position was adopted. A manual broker TP may remain in place unless another existing canonical Trend exit closes the position earlier.
- Fixed TP reconciliation begins only after `protectionStatus=PROTECTED`.
- Daily Recovery TP is explicitly disabled for `entrySource=MANUAL`.

This keeps TP behavior deterministic: **Trend Fixed TP ON = canonical Trend target wins; Trend Fixed TP OFF = SEMI adds no new TP policy.**

## 11. Trend management parity after adoption

After successful adoption and protection reconciliation, the position enters the same canonical Trend management function.

Required parity:

### 11.1 Break-even

At favorable move `>= +6` price units:

- canonical BE candidate = actual position entry;
- if broker SL is already at entry or tighter, record BE as satisfied without loosening;
- otherwise tighten SL to entry using the existing idempotent command pattern.

### 11.2 Partial at +10

At favorable move `>= +10` price units:

- close exactly one third when the broker volume step/minimum-volume rules permit it;
- persist the actual remaining expected volume;
- do not repeatedly partial-close the same milestone.

If the manual lot cannot support a legal one-third partial at the broker step, the runtime must not reject the original manual trade merely because of its lot. Instead the +10 partial milestone reports a structured `SKIPPED_BROKER_VOLUME` / equivalent fail-safe status and the remainder continues under Trend management. This is different from algorithmic Trend entry, where fixed-volume validation can reject an invalid lot before order creation.

### 11.3 FastMove

Use the same Trend FastMove contract:

- activation distance: +10;
- live bid/ask based favorable peak;
- giveback distance: 6;
- only tighten against the current/tightest known stop;
- obey broker stop/freeze limits;
- preserve peak and attempt state durably.

### 11.4 Structural trailing

Once canonical confirmed M15 structure is available for the adopted position, structural trailing may take over according to the same Trend rules. Structural candidates may only tighten the stop.

For a manual position there is no algorithmic signal candle. The structural lookback anchor must therefore use a truthful manual lifecycle anchor such as `manualOpenedAt` / the first eligible closed M15 after entry, not a fabricated signal timestamp.

### 11.5 Hold/reversal/exit

Reuse Trend hold/reversal/exit logic where that logic is valid for a manual-origin Trend-managed position. Any rule that currently assumes an algorithmic signal timestamp/pattern must be adapted to the manual lifecycle anchor instead of inventing signal context.

## 12. Manual operator actions after adoption

### 12.1 Manual close

If the exact managed ticket disappears because the operator closes it manually:

- journal `SEMI_MANUAL_POSITION_CLOSED` or the canonical managed-close event with `entrySource=MANUAL`;
- clear durable managed state;
- never reopen the position;
- if mode remains SEMI, return to `WAITING_MANUAL_ENTRY`;
- preserve a monotonic adoption watermark so another position that predates the completed managed lifecycle cannot later be reclassified as a new SEMI candidate.

A subsequent adoption requires a different eligible manual ticket with `openedAt` newer than both the current SEMI activation boundary and the completed/manual-management watermark.

### 12.2 Manual SL tightening

If broker SL is tighter than the runtime's last structural/protective stop:

- accept the tighter stop;
- update the protection baseline;
- never move it backwards.

### 12.3 Manual SL loosening/removal

If broker SL becomes less protective than the tightest canonical managed stop:

- reconcile back to the tightest canonical allowed stop;
- emit an observable reconciliation event;
- if broker rules temporarily prevent reconciliation, expose `PROTECTION_BLOCKED` rather than silently accepting weaker risk;
- suspend normal Trend mutations until protection returns to `PROTECTED`.

### 12.4 Manual TP changes

When Fixed TP is enabled, retain the canonical Trend Fixed TP reconciliation target. When Fixed TP is disabled, SEMI does not create a new TP-management rule merely because the operator changed TP manually.

## 13. Mode transitions with an open manual ticket

### SEMI -> AUTO

- keep the adopted manual ticket under Trend management;
- do not relabel it as a system entry;
- AUTO strategy logic may evaluate read-only, but no new order may be created while the managed XAUUSD position exists;
- after the ticket closes, normal AUTO acquisition may resume.

### SEMI -> PAUSE

- no new manual adoption;
- no new algorithmic entry;
- retain protective management for the already-owned ticket under the current position-management pass-through principle.

### SEMI -> explicit TREND/SIDEWAY

If these modes remain supported, the existing ticket remains owned and continues its locked `managementStrategy=TREND` lifecycle until close. Mode transitions must not silently switch a live manual ticket to Sideway management.

## 14. Semantic UI and Signal UI V3

Signal UI must show real engine state. It must not infer +6/+10/FastMove/trailing milestones.

Prefer an additive extension to the current semantic UI contract while retaining `version: 2`, because existing web validity checks currently require version 2. A contract-version bump is unnecessary unless implementation proves an incompatible change is unavoidable.

### 14.1 Suggested additive position telemetry

When a managed or provisionally owned position exists, expose fields equivalent to:

- `entrySource: MANUAL | SYSTEM`;
- `managementStrategy: TREND | SIDEWAY | null`;
- `managementStartedAt`;
- `initialStopDistance`;
- `breakEvenStatus`;
- `partialStatus`;
- `fastMoveStatus`;
- `trailingStatus`;
- `protectionStatus`;
- existing ticket, side, volume, entry, current SL, TP, floating P/L.

Status vocabularies should be small and based on durable runtime facts, for example:

- protection: `PENDING | PROTECTED | PROTECTION_BLOCKED`;
- BE: `PENDING | APPLIED`;
- partial: `PENDING | APPLIED | SKIPPED_BROKER_VOLUME`;
- FastMove: `INACTIVE | ACTIVE | STRUCTURE_TAKEOVER`;
- trailing: `WAITING | ACTIVE`.

When protection is not `PROTECTED`, BE/partial/FastMove/trailing fields must not imply that normal management is active.

### 14.2 SEMI waiting presentation

When mode is SEMI and no ticket is owned:

- Mode: `BÁN TỰ ĐỘNG`;
- BOT ĐANG LÀM GÌ?: `CHỜ BẠN VÀO LỆNH`;
- Auto Entry: `TẮT`;
- Management strategy: `TREND`;
- waiting condition: a new eligible manual XAUUSD position from MT5;
- classifier regime/recommended strategy remains informational only;
- do not render a Trend algorithmic entry-check pipeline as though it were gating the manual entry.

`effectiveStrategy` semantics must not falsely imply that the bot will create a Trend entry. If the existing field cannot represent this cleanly, add explicit `entryMode/source` and `managementStrategy` fields and make the UI label the distinction.

### 14.3 SEMI managing presentation

When an adopted ticket is managed:

- BOT ĐANG LÀM GÌ?: `ĐANG QUẢN LÝ LỆNH TAY` only when `protectionStatus=PROTECTED`;
- while `PENDING`, show `ĐANG THIẾT LẬP BẢO VỆ LỆNH TAY`;
- while `PROTECTION_BLOCKED`, show an explicit protection-blocked alert rather than normal management;
- Entry Source: `MANUAL`;
- Management: `TREND`;
- show actual ticket, side, entry, current volume, current SL and Fixed TP if present;
- show initial SL distance = 6;
- show real BE, partial, FastMove, structural trailing and protection statuses from semantic telemetry.

No milestone badge may be calculated only in React from price guesses when the engine has not exposed the state.

## 15. Control Center and operator controls

The canonical mode selector should expose `SEMI / BÁN TỰ ĐỘNG` alongside existing modes.

Mode changes must continue through the existing authorized canonical bot-mode control path. This feature must not introduce a second state file or a UI-only SEMI flag.

The Control Center should make the semantics explicit:

- `AUTO`: bot may create entries subject to strategy gates;
- `SEMI`: operator enters manually; bot manages an eligible adopted ticket as Trend;
- `PAUSE`: no new entries/adoptions.

Changing mode does not by itself ARM LIVE, restart lifecycle, create an order, or mutate an existing position.

Telegram mode control, if it presents the canonical set of modes, should expose SEMI using the same backend mode contract rather than implementing separate Telegram-only behavior.

## 16. Observability and audit events

Add structured events or equivalent canonical audit records for at least:

- `SEMI_MANUAL_POSITION_DETECTED`;
- `SEMI_ADOPTION_BLOCKED` with reason code;
- `SEMI_MANUAL_POSITION_ADOPTED`;
- `SEMI_INITIAL_SL_ALREADY_TIGHTER`;
- `SEMI_INITIAL_SL_RECONCILED`;
- `SEMI_PROTECTION_BLOCKED`;
- `SEMI_MANUAL_SL_TIGHTER_ACCEPTED`;
- `SEMI_MANUAL_SL_RESTORED`;
- `SEMI_MANUAL_POSITION_CLOSED`.

Existing Trend events for +6, +10, Fixed TP, FastMove, structural stop, hold and exit should remain canonical where possible, augmented with `entrySource=MANUAL` / management ownership context rather than duplicated into a parallel event family.

Decision Monitor / semantic status should make the following operator questions answerable read-only:

1. Is SEMI active?
2. Is the bot waiting for a manual position, establishing protection, blocked on protection, or managing one?
3. Which ticket does it own?
4. Was the position manual or system-created?
5. Is the ticket protected by the canonical SL?
6. Has BE been applied?
7. Has the +10 partial been applied or skipped for broker-volume reasons?
8. Is FastMove active?
9. Has structural trailing taken over?
10. Is Fixed TP enabled and what broker TP is currently present?

## 17. Failure handling

SEMI fails closed for acquisition and fail-safe for protection.

Examples:

- unknown position provenance -> no adoption;
- multiple positions -> no adoption;
- missing account identity -> no adoption;
- stale mode/activation provenance -> no adoption;
- account changed -> stop mutations for unresolved ownership and surface block;
- execution lock busy -> retry on later cycle, no duplicate ownership;
- broker SL reconcile rejected -> explicit protection block, no widening and no normal management mutations;
- Fixed TP reconcile rejected -> retain managed ownership, expose TP reconciliation failure under existing Trend semantics;
- state/broker ticket mismatch -> no mutation of a different ticket;
- restart with durable manual state -> reconcile exact ticket only.

A failure to adopt must never cause an automated close. A failure to prove ownership must never cause mutation of an uncertain position.

## 18. TDD and CI acceptance matrix

Implementation must start with RED tests/contracts and only then add behavior.

Minimum coverage:

### Mode and control

- bot-mode enum accepts SEMI canonically;
- mode provenance exposes SEMI activation boundary;
- Web Control Center exposes the third mode;
- Telegram/control consumers do not reject SEMI;
- PAUSE/AUTO existing mode behavior regressions pass.

### No auto entry in SEMI

- Trend new-order gate rejects algorithmic `/v1/orders` while SEMI;
- Sideway new-order gate rejects algorithmic `/v1/orders` while SEMI;
- no code path creates an entry order merely because a manual signal exists;
- existing owned-position PATCH/close management remains allowed through canonical guards.

### Manual ownership

- only positions opened after SEMI activation are eligible;
- manual magic/origin is required;
- bot/Sideway/Trend/validation magic is rejected;
- ambiguous/multiple positions block;
- candidate is revalidated under the shared execution lock;
- provisional exact-ticket ownership is durable before protection reconciliation;
- `PENDING`/`PROTECTION_BLOCKED` cannot execute normal Trend management mutations;
- exact ticket/account is persisted;
- restart resumes the exact ticket and cannot adopt a replacement silently;
- post-close adoption watermark prevents a stale pre-existing manual position from being adopted as a new trade.

### Initial SL

- BUY entry 5000 -> canonical stop 4994;
- SELL entry 5000 -> canonical stop 5006;
- missing SL is reconciled to 6-price protection;
- wider SL is tightened;
- tighter SL is preserved;
- subsequent manual tightening is preserved;
- subsequent loosening/removal is restored to the tightest canonical stop;
- broker-illegal canonical stop produces `PROTECTION_BLOCKED`, never a wider stop and never an automatic close;
- protection recovery transitions `PROTECTION_BLOCKED -> PROTECTED` before normal Trend mutations resume.

### Fixed TP

- Trend Fixed TP ON calculates target from actual manual fill and reconciles an existing different manual TP to the canonical Trend target;
- Trend Fixed TP OFF does not invent or normalize a TP for SEMI;
- Fixed TP reconciliation does not run before protection is `PROTECTED`;
- Daily Recovery TP is never selected for `entrySource=MANUAL`.

### Trend management parity

- +6 BE parity for BUY and SELL;
- +10 one-third partial parity;
- manual lot that cannot legally partial is marked skipped rather than causing retroactive trade rejection;
- FastMove activation +10 / giveback 6 parity;
- M15 structural trailing parity and monotonicity;
- hold/reversal/exit behavior uses a truthful manual time anchor;
- Trend Fixed TP parity from actual fill;
- Daily Recovery TP is not used for `entrySource=MANUAL`.

### Lifecycle and transitions

- manual close clears managed state and never reopens;
- SEMI -> AUTO continues management and blocks new AUTO entry until close;
- SEMI -> PAUSE continues protection but allows no new adoption;
- account change fails closed;
- Sideway existing path remains unaffected;
- shared execution lock prevents acquisition races.

### Signal UI V3 and semantic observability

- SEMI waiting renders `CHỜ BẠN VÀO LỆNH` and auto entry OFF;
- it does not render algorithmic Trend entry checks as the manual gate;
- managed manual ticket renders `entrySource=MANUAL`, `managementStrategy=TREND`;
- protection `PENDING` and `PROTECTION_BLOCKED` have explicit UI states and do not masquerade as normal management;
- BE/partial/FastMove/trailing/protection badges come only from semantic fields;
- unknown telemetry remains unknown rather than inferred;
- existing Signal UI V3 contracts remain green.

### Platform regression

- Linux CI where applicable;
- Windows/PowerShell source/runtime contracts where applicable;
- API and Web builds;
- existing Fixed TP regressions;
- existing Trend singleton/execution-lock regressions;
- existing AUTO reversal/current-position/account-mode regressions;
- canonical PR gate;
- `git diff --check`.

No CI or production acceptance test may create a LIVE order.

## 19. Likely implementation boundaries

Exact files are resolved during the implementation plan, but the expected boundaries are:

- canonical bot-mode contract/API/service and its provenance;
- Trend/Sideway mode gates;
- MT5 bridge position read model if manual provenance fields are missing;
- Trend durable managed-state schema and manual adoption/protection path;
- shared execution lock integration;
- semantic UI serializer / Decision Monitor observability;
- Signal UI V3;
- Control Center mode selector and types/API;
- Telegram canonical mode selector if it enumerates modes;
- focused SEMI TDD tests and canonical CI workflow coverage.

Avoid unrelated refactoring. Reuse existing Trend management helpers and event contracts wherever their semantics are already correct.

## 20. Rollout and production safety

Implementation, PR, merge and deployment must not implicitly activate SEMI.

Required rollout principles:

1. Source implementation and CI first.
2. Merge only after required CI is green.
3. Production deployment preserves current canonical mode/ARM state unless the operator explicitly requests a change.
4. Deployment does not place a test order.
5. Post-deploy acceptance is read-only: source/deployment provenance, API/UI contract, lifecycle/account safety and mode semantics.
6. SEMI becomes active only through an explicit operator mode change after deployment.
7. First behavioral validation should preferably be on DEMO using an operator-created manual position; LIVE validation must never be synthesized by the rollout itself.

## 21. Acceptance definition

The feature is complete when all of the following are true:

- `SEMI` exists as a canonical mode across runtime and operator surfaces;
- SEMI cannot automatically create a new entry order;
- a single, provably manual, new XAUUSD ticket can be adopted automatically;
- actual manual volume is accepted without applying algorithmic entry-volume rejection;
- canonical initial SL is 6 price units from actual fill and never loosens a tighter stop;
- provisional ownership is explicit until 6-price protection is proven, and normal Trend management runs only under `PROTECTED`;
- the adopted ticket runs through the canonical Trend BE, partial, FastMove, structural trailing, Fixed TP, hold/reversal/exit management;
- Trend Fixed TP ON owns the canonical target; Trend Fixed TP OFF adds no SEMI-specific TP rule;
- Daily Recovery is off for manual-origin positions;
- mode transitions preserve management ownership safely;
- manual close never causes re-entry or stale re-adoption;
- semantic/runtime telemetry truthfully exposes ownership, protection and management milestones;
- Signal UI V3 clearly distinguishes manual entry from Trend management;
- AUTO, PAUSE, Sideway and existing LIVE safety contracts remain green;
- production rollout performs no unsolicited mode/ARM/order/position mutation.
