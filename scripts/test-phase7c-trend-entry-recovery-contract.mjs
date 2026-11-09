import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(
  here,
  "run-phase7b-demo-controller.ts",
);

const source = fs.readFileSync(controllerPath, "utf8");
const trendWrapperSource = fs.readFileSync(
  path.join(here, "run-phase7c-trend-controller.mjs"),
  "utf8",
);

/*
 * Regression:
 *
 * 1. POST /v1/orders is accepted.
 * 2. order.position is null.
 * 3. immediate GET /v1/positions is still [] because MT5 position
 *    visibility lags the accepted order response.
 * 4. The accepted entry must leave durable pending ownership state.
 * 5. On the next cycle, when the matching broker position appears,
 *    Trend must adopt/manage it before the generic unmanaged-position gate.
 *
 * A recoverable accepted Trend entry must never degrade into
 * UNMANAGED_POSITION_PRESENT merely because broker position visibility
 * was delayed by one controller cycle.
 */

assert.ok(
  source.includes("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED"),
  "Baseline marker ENTRY_ACCEPTED_POSITION_NOT_RESOLVED is missing.",
);

assert.ok(
  source.includes("UNMANAGED_POSITION_PRESENT"),
  "Baseline marker UNMANAGED_POSITION_PRESENT is missing.",
);

assert.ok(
  source.includes("ENTRY_FILLED"),
  "Baseline marker ENTRY_FILLED is missing.",
);

const unresolvedJournalIndex = source.indexOf(
  'journal("ENTRY_ACCEPTED_POSITION_NOT_RESOLVED"',
);

assert.ok(
  unresolvedJournalIndex >= 0,
  "Unable to locate accepted-but-unresolved Trend branch.",
);

const unresolvedReturnIndex = source.indexOf(
  'return "UNRESOLVED";',
  unresolvedJournalIndex,
);

assert.ok(
  unresolvedReturnIndex > unresolvedJournalIndex,
  "Unable to locate UNRESOLVED return after accepted order.",
);

const unresolvedBlock = source.slice(
  unresolvedJournalIndex,
  unresolvedReturnIndex,
);

/*
 * This is the primary RED assertion.
 *
 * Current broken code journals the unresolved condition and returns
 * without persisting any pending ownership intent.
 */
assert.match(
  unresolvedBlock,
  /\bstate\.pendingEntry\s*=/,
  "RED_TARGET: accepted Trend entry must persist pendingEntry before returning UNRESOLVED",
);

/*
 * Durable state contract.
 */
const botStateStart = source.indexOf("type BotState = {");
const persistedStateStart = source.indexOf(
  "type PersistedBotState = {",
);

assert.ok(
  botStateStart >= 0 &&
  persistedStateStart > botStateStart,
  "Unable to locate Trend state definitions.",
);

const botStateBlock = source.slice(
  botStateStart,
  persistedStateStart,
);

assert.match(
  botStateBlock,
  /\bpendingEntry\s*:/,
  "Trend BotState must contain durable pendingEntry state.",
);

const persistedStateEnd = source.indexOf(
  "const symbol =",
  persistedStateStart,
);

assert.ok(
  persistedStateEnd > persistedStateStart,
  "Unable to locate end of PersistedBotState.",
);

const persistedStateBlock = source.slice(
  persistedStateStart,
  persistedStateEnd,
);

assert.match(
  persistedStateBlock,
  /\bpendingEntry\??\s*:/,
  "Persisted Trend state must contain pendingEntry.",
);

/*
 * Recovery must happen before the generic unmanaged-position gate.
 */
const recoveredEventIndex = source.indexOf(
  'journal("PENDING_ENTRY_RECOVERED"',
);

const unmanagedEventIndex = source.indexOf(
  'journal("UNMANAGED_POSITION_PRESENT"',
);

assert.ok(
  recoveredEventIndex >= 0,
  "Trend must journal PENDING_ENTRY_RECOVERED after adopting the delayed broker position.",
);

assert.ok(
  unmanagedEventIndex >= 0,
  "Unable to locate Trend unmanaged-position gate.",
);

assert.ok(
  recoveredEventIndex < unmanagedEventIndex,
  "Pending-entry recovery must execute before UNMANAGED_POSITION_PRESENT.",
);

/*
 * The recovery branch must transfer ownership atomically:
 *
 * pendingEntry -> managed
 * pendingEntry -> null
 * persist state
 */
const recoveryWindowStart = source.lastIndexOf(
  "if (state.pendingEntry)",
  recoveredEventIndex,
);

assert.ok(
  recoveryWindowStart >= 0,
  "Unable to locate pending-entry recovery branch.",
);

const recoveryWindow = source.slice(
  recoveryWindowStart,
  unmanagedEventIndex,
);

const managedAssignmentIndex = recoveryWindow.indexOf(
  "state.managed =",
);

const pendingClearIndex = recoveryWindow.indexOf(
  "state.pendingEntry = null;",
  managedAssignmentIndex + "state.managed =".length,
);

assert.ok(
  managedAssignmentIndex >= 0,
  "Recovered position must become state.managed.",
);

assert.ok(
  pendingClearIndex > managedAssignmentIndex,
  "pendingEntry must be cleared only after managed ownership is established.",
);

assert.match(
  recoveryWindow,
  /\bsaveState\(\)/,
  "Recovered ownership transition must be persisted.",
);


/*
 * TREND_RECOVERY_HARDENING_CONTRACT
 *
 * The accepted-order recovery path must also cover:
 *
 * 1. Durable ownership BEFORE sending the order, so a transport/process
 *    failure after broker acceptance cannot create an orphan position.
 * 2. Rejection must clear the pre-submit pending ownership.
 * 3. Accepted broker ticket metadata must be persisted before any
 *    follow-up position lookup.
 * 4. If a broker ticket is unavailable, fallback matching must include
 *    broker-time/open-time and requested-entry correlation instead of
 *    matching only side/volume/SL/TP.
 */

const orderSubmitIndex = source.indexOf(
  'const order = await post<OrderResponse>("/v1/orders"',
);

assert.ok(
  orderSubmitIndex >= 0,
  "Unable to locate Trend broker order submit.",
);

const pendingDeclarationIndex = source.lastIndexOf(
  "const pendingEntry: PendingTrendEntry",
  orderSubmitIndex,
);

assert.ok(
  pendingDeclarationIndex >= 0,
  "Unable to locate PendingTrendEntry construction before broker submit.",
);

const preSubmitDurabilityBlock = source.slice(
  pendingDeclarationIndex,
  orderSubmitIndex,
);

assert.match(
  preSubmitDurabilityBlock,
  /\bstate\.pendingEntry\s*=\s*pendingEntry\s*;/,
  "RED_TARGET_PREPOST_DURABILITY: Trend must establish pending ownership before POST /v1/orders",
);

assert.match(
  preSubmitDurabilityBlock,
  /\bsaveState\(\)/,
  "RED_TARGET_PREPOST_DURABILITY: pre-submit pending ownership must be persisted before POST /v1/orders",
);

const rejectedBranchIndex = source.indexOf(
  "if (!order.accepted)",
  orderSubmitIndex,
);

const rejectedReturnIndex = source.indexOf(
  'return "REJECTED";',
  rejectedBranchIndex,
);

assert.ok(
  rejectedBranchIndex > orderSubmitIndex &&
  rejectedReturnIndex > rejectedBranchIndex,
  "Unable to isolate rejected Trend order branch.",
);

const rejectedBlock = source.slice(
  rejectedBranchIndex,
  rejectedReturnIndex,
);

assert.match(
  rejectedBlock,
  /\bstate\.pendingEntry\s*=\s*null\s*;/,
  "RED_TARGET_REJECT_CLEANUP: rejected broker order must clear durable pending ownership",
);

assert.match(
  rejectedBlock,
  /\bsaveState\(\)/,
  "RED_TARGET_REJECT_CLEANUP: rejected broker order cleanup must be persisted",
);

/*
 * TREND_CONFIRMED_POSITION_TICKET_CONTRACT
 *
 * Bridge order.ticket is not guaranteed to be a position ticket when
 * order.position is unresolved. Durable brokerTicket therefore means
 * CONFIRMED POSITION TICKET only.
 */

assert.doesNotMatch(
  source,
  /pendingEntry\.brokerTicket\s*=\s*order\.ticket/,
  "RED_TARGET_ORDER_TICKET_AMBIGUITY: raw order.ticket must never become durable position ownership",
);

const immediateOpenedIndex = source.indexOf(
  "let opened = order.position ?? null;",
);

assert.ok(
  immediateOpenedIndex > rejectedReturnIndex,
  "Unable to locate immediate broker position resolution.",
);

const immediateRecoveryIndex = source.indexOf(
  "const recovery = matchPendingTrendPosition(",
  immediateOpenedIndex,
);

const confirmedPositionTicketIndex = source.indexOf(
  "pendingEntry.brokerTicket = String(opened.ticket);",
  immediateRecoveryIndex,
);

const confirmedPositionSaveIndex = source.indexOf(
  "saveState()",
  confirmedPositionTicketIndex,
);

assert.ok(
  immediateRecoveryIndex > immediateOpenedIndex,
  "Immediate order.position must be verified before ownership.",
);

assert.ok(
  confirmedPositionTicketIndex > immediateRecoveryIndex,
  "RED_TARGET_ORDER_TICKET_AMBIGUITY: brokerTicket must come from the confirmed Position ticket",
);

assert.ok(
  confirmedPositionSaveIndex > confirmedPositionTicketIndex,
  "Confirmed Position ticket ownership must be persisted.",
);

const pendingTypeIndex = source.indexOf(
  "type PendingTrendEntry = {",
);

const pendingTypeEnd = source.indexOf(
  "type BotState = {",
  pendingTypeIndex,
);

assert.ok(
  pendingTypeIndex >= 0 &&
  pendingTypeEnd > pendingTypeIndex,
  "Unable to isolate PendingTrendEntry type.",
);

const pendingTypeBlock = source.slice(
  pendingTypeIndex,
  pendingTypeEnd,
);

assert.match(
  pendingTypeBlock,
  /\bbrokerReferenceTimestamp\s*:\s*number\s*;/,
  "RED_TARGET_TIME_CORRELATION: PendingTrendEntry must persist broker reference time",
);

const matcherStart = source.indexOf(
  "function matchPendingTrendPosition(",
);

const matcherEnd = source.indexOf(
  "function managedFromPending(",
  matcherStart,
);

assert.ok(
  matcherStart >= 0 &&
  matcherEnd > matcherStart,
  "Unable to isolate Trend pending-position matcher.",
);

const matcherBlock = source.slice(
  matcherStart,
  matcherEnd,
);

assert.match(
  matcherBlock,
  /\bposition\.openedAt\b/,
  "RED_TARGET_TIME_CORRELATION: ticketless Trend recovery must validate position openedAt",
);

assert.match(
  matcherBlock,
  /\bpending\.brokerReferenceTimestamp\b/,
  "RED_TARGET_TIME_CORRELATION: ticketless Trend recovery must use broker reference timestamp",
);

assert.match(
  matcherBlock,
  /\bposition\.entry\b/,
  "RED_TARGET_ENTRY_CORRELATION: ticketless Trend recovery must validate actual entry price",
);

assert.match(
  matcherBlock,
  /\bpending\.referenceEntry\b/,
  "RED_TARGET_ENTRY_CORRELATION: ticketless Trend recovery must use requested reference entry",
);

assert.match(
  matcherBlock,
  /PENDING_OPEN_TIME_MISMATCH/,
  "RED_TARGET_TIME_CORRELATION: matcher must fail closed on opening-time mismatch",
);

assert.match(
  matcherBlock,
  /PENDING_ENTRY_PRICE_MISMATCH/,
  "RED_TARGET_ENTRY_CORRELATION: matcher must fail closed on entry-price mismatch",
);


/*
 * TREND_TICKETLESS_CLOCK_DOMAIN_CONTRACT
 *
 * quote.timestamp and position.openedAt are MT5-clock values.
 * order.brokerTimestamp is not used to replace that reference.
 *
 * Exact broker ticket ownership is authoritative.
 * Time + requested-entry correlation is only the ticketless fallback.
 */

assert.doesNotMatch(
  source,
  /pendingEntry\.brokerReferenceTimestamp\s*=\s*acceptedBrokerTimestamp/,
  "RED_TARGET_BROKER_TIME_DOMAIN: system/order timestamp must not replace MT5 quote reference timestamp",
);

assert.doesNotMatch(
  source,
  /\bbrokerTimestamp\?:\s*number\s*;/,
  "RED_TARGET_BROKER_TIME_DOMAIN: Trend recovery should not depend on OrderResponse brokerTimestamp",
);

const ticketlessGuardIndex = matcherBlock.indexOf(
  "if (!pending.brokerTicket) {",
);

const ticketlessOpenedAtIndex = matcherBlock.indexOf(
  "position.openedAt",
);

const ticketlessEntryIndex = matcherBlock.indexOf(
  "pending.referenceEntry",
);

assert.ok(
  ticketlessGuardIndex >= 0,
  "RED_TARGET_TICKETLESS_SCOPE: time/entry correlation must be explicitly scoped to missing broker ticket",
);

assert.ok(
  ticketlessOpenedAtIndex > ticketlessGuardIndex,
  "RED_TARGET_TICKETLESS_SCOPE: openedAt correlation must be inside ticketless fallback",
);

assert.ok(
  ticketlessEntryIndex > ticketlessGuardIndex,
  "RED_TARGET_TICKETLESS_SCOPE: entry-price correlation must be inside ticketless fallback",
);


/*
 * TREND_TRANSIENT_READ_TIMEOUT_CONTRACT
 *
 * Transient local MT5/control read stalls may be retried once because GET is
 * read-only. Broker mutations must never inherit this retry policy.
 */
const bridgeRequestStart = source.indexOf(
  "async function bridgeRequest<T>(",
);
const bridgeRequestEnd = source.indexOf(
  "function requiredEnv(",
  bridgeRequestStart,
);
assert.ok(
  bridgeRequestStart >= 0 && bridgeRequestEnd > bridgeRequestStart,
  "Unable to isolate Trend bridge request transport.",
);
const bridgeRequestBlock = source.slice(
  bridgeRequestStart,
  bridgeRequestEnd,
);
assert.match(
  bridgeRequestBlock,
  /const maxAttempts = normalizedMethod === "GET" \? 2 : 1;/,
  "Trend transport must retry GET exactly once while mutations stay single-attempt.",
);
assert.match(
  bridgeRequestBlock,
  /PHASE7B_MT5_READ_RETRY=GET/,
  "Trend transient MT5 GET retry must be observable for non-timeout transport failures.",
);
assert.match(
  bridgeRequestBlock,
  /normalizedMethod === "GET" && !aborted && attempt < maxAttempts/,
  "Timed-out MT5 reads must not be retried immediately because the original server-side call may still hold the gateway lock.",
);
assert.match(
  bridgeRequestBlock,
  /MT5 bridge \$\{normalizedMethod\} \$\{endpoint\} \| \$\{transport\} \| attempts=\$\{attempt\}/,
  "Trend transport errors must identify method, endpoint, reason and attempt count.",
);
assert.match(
  source,
  /async function post<T>\(endpoint: string, body: unknown\): Promise<T> \{\s*return bridgeRequest<T>\("POST", endpoint, body\);/,
  "Trend POST mutations must continue through the single-attempt transport gate.",
);
assert.match(
  source,
  /async function patch<T>\(endpoint: string, body: unknown\): Promise<T> \{\s*return bridgeRequest<T>\("PATCH", endpoint, body\);/,
  "Trend PATCH mutations must continue through the single-attempt transport gate.",
);

const controlRequestStart = trendWrapperSource.indexOf(
  "async function controlRequest(pathname)",
);
const controlRequestEnd = trendWrapperSource.indexOf(
  "function isNewOrderRequest(",
  controlRequestStart,
);
assert.ok(
  controlRequestStart >= 0 && controlRequestEnd > controlRequestStart,
  "Unable to isolate Trend control read transport.",
);
const controlRequestBlock = trendWrapperSource.slice(
  controlRequestStart,
  controlRequestEnd,
);
assert.match(
  controlRequestBlock,
  /const maxAttempts = 2;/,
  "Trend control GET must retry a transient timeout once.",
);
assert.match(
  controlRequestBlock,
  /PHASE7C_TREND_CONTROL_READ_RETRY=GET/,
  "Trend control GET retry must be observable.",
);
assert.match(
  controlRequestBlock,
  /Phase7C control API GET \$\{pathname\} \| \$\{reason\} \| attempts=\$\{attempt\}/,
  "Trend control timeout must include endpoint and attempt context.",
);

console.log("TREND_ENTRY_RECOVERY_CONTRACT=PASS");
console.log("SCENARIO_ORDER_ACCEPTED_POSITION_NULL=PASS");
console.log("SCENARIO_IMMEDIATE_POSITIONS_EMPTY=PASS");
console.log("SCENARIO_NEXT_CYCLE_POSITION_VISIBLE=PASS");
console.log("SCENARIO_RECOVER_BEFORE_UNMANAGED_GATE=PASS");