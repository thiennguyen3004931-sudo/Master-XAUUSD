import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const trendSource = readFileSync(path.join(scriptsDir, "run-phase7b-demo-controller.ts"), "utf8");

function block(startMarker, endMarker) {
  const start = trendSource.indexOf(startMarker);
  assert.notEqual(start, -1, `source must contain ${startMarker}`);
  const end = trendSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `source must contain ${endMarker} after ${startMarker}`);
  return trendSource.slice(start, end);
}

test("Trend controller reads only immutable Trend Fixed TP runtime configuration", () => {
  assert.match(trendSource, /ZIQ_PHASE7C_TREND_FIXED_TP_ENABLED/,
    "RED_TARGET: Trend controller must read Trend Fixed TP enable from canonical launcher env.");
  assert.match(trendSource, /ZIQ_PHASE7C_TREND_FIXED_TP_DISTANCE/,
    "RED_TARGET: Trend controller must read Trend Fixed TP distance from canonical launcher env.");
  assert.doesNotMatch(trendSource, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_/,
    "Trend controller must never consume Sideway Fixed TP configuration.");
});

test("pending and managed Trend state schemas carry the immutable Fixed TP snapshot", () => {
  const pendingType = block("type PendingTrendEntry = {", "type BotState = {");
  for (const field of ["fixedTpEnabled", "fixedTpDistance", "fixedTpPrice"]) {
    assert.match(pendingType, new RegExp(`${field}\\??:`),
      `RED_TARGET: PendingTrendEntry must persist ${field}.`);
  }

  const managedType = block("type ManagedState = {", "type StrategyEntryConfigSnapshot = {");
  for (const field of ["fixedTpEnabled", "fixedTpDistance", "fixedTpPrice"]) {
    assert.match(managedType, new RegExp(`${field}\\??:`),
      `RED_TARGET: ManagedState must persist ${field}.`);
  }
});

test("Trend snapshots Fixed TP before durable pending entry is saved", () => {
  const pendingCreation = block("const pendingEntry: PendingTrendEntry = {", "state.pendingEntry = pendingEntry;");
  assert.match(pendingCreation, /fixedTpEnabled\s*:/,
    "RED_TARGET: pending entry must snapshot fixedTpEnabled before save/order submission.");
  assert.match(pendingCreation, /fixedTpDistance\s*:/,
    "RED_TARGET: pending entry must snapshot fixedTpDistance before save/order submission.");
  assert.match(pendingCreation, /fixedTpPrice\s*:/,
    "RED_TARGET: pending entry must snapshot entry-derived fixedTpPrice before save/order submission.");
});

test("Trend recovery copies the pending Fixed TP snapshot into managed state", () => {
  const managedFromPending = block("function managedFromPending(", "async function");
  assert.match(managedFromPending, /fixedTpEnabled\s*:\s*pending\.fixedTpEnabled/,
    "RED_TARGET: recovery must preserve pending fixedTpEnabled.");
  assert.match(managedFromPending, /fixedTpDistance\s*:\s*pending\.fixedTpDistance/,
    "RED_TARGET: recovery must preserve pending fixedTpDistance.");
  assert.match(managedFromPending, /fixedTpPrice\s*:/,
    "RED_TARGET: recovery must preserve/rederive immutable fixedTpPrice from the managed entry.");
});

test("legacy persisted Trend state restores Fixed TP disabled", () => {
  const loadState = block("function loadState(file: string): BotState", "function saveState");
  assert.match(loadState, /const fixedTpEnabled\s*=\s*raw\.fixedTpEnabled\s*===\s*true\s*&&\s*Number\.isFinite\(distance\)\s*&&\s*distance\s*>\s*0\s*&&\s*Number\.isFinite\(price\)/,
    "RED_TARGET: legacy/malformed state may enable Fixed TP only when all persisted Fixed TP fields are explicitly valid.");
  assert.match(loadState, /fixedTpEnabled\s*:\s*fixedTpEnabled\s*\?\s*true\s*:\s*false/,
    "RED_TARGET: old pending/managed state without valid Fixed TP fields must restore disabled.");
  assert.match(loadState, /fixedTpDistance\s*:\s*fixedTpEnabled\s*\?\s*distance\s*:\s*0/,
    "RED_TARGET: old state must restore Fixed TP distance 0.");
  assert.match(loadState, /fixedTpPrice\s*:\s*fixedTpEnabled\s*\?\s*price\s*:\s*null/,
    "RED_TARGET: old state must restore Fixed TP price null.");
  assert.match(loadState, /pendingEntry\s*:\s*normalizePendingEntry\(parsed\.pendingEntry\)/,
    "RED_TARGET: v2 pending state must pass through the legacy-safe Fixed TP normalizer.");
  assert.match(loadState, /managed\s*:\s*normalizeManagedState\(parsed\.managed\)/,
    "RED_TARGET: persisted managed state must pass through the legacy-safe Fixed TP normalizer.");
});

test("Trend sends Fixed TP to MT5 on initial non-Recovery order and preserves canonical Recovery TP precedence", () => {
  const submitFlow = block("const fixedTpSnapshot = buildFixedTpSnapshot({", "if (!order.accepted) {");
  assert.match(submitFlow, /const\s+brokerTakeProfit\s*=\s*dailyRecovery\.mode\s*===\s*["']RECOVERY_TP["'][\s\S]*?takeProfit[\s\S]*?fixedTpSnapshot\.enabled[\s\S]*?fixedTpSnapshot\.targetPrice[\s\S]*?takeProfit/,
    "RED_TARGET: non-Recovery Trend orders with Fixed TP enabled must send the Fixed TP target to MT5 while Recovery keeps canonical Recovery TP.");
  assert.match(submitFlow, /takeProfit\s*:\s*brokerTakeProfit/,
    "RED_TARGET: Trend initial /v1/orders payload must use brokerTakeProfit.");
});

test("Trend verifies actual fill, commits ownership, then reconciles broker Fixed TP", () => {
  const fillFlow = block("const filledFixedTpSnapshot = buildFixedTpSnapshot({", "async function resolveDailyRecoveryPlan(");
  const managedIndex = fillFlow.indexOf("state.managed = {");
  const pendingClearIndex = fillFlow.indexOf("state.pendingEntry = null;", managedIndex);
  const saveIndex = fillFlow.indexOf("saveState();", pendingClearIndex);
  const filledIndex = fillFlow.indexOf('journal("ENTRY_FILLED"', saveIndex);
  const reconcileIndex = fillFlow.indexOf("await reconcileFixedTpBrokerTakeProfit({", filledIndex);

  assert.ok(managedIndex >= 0,
    "RED_TARGET: Trend actual fill must create managed ownership.");
  assert.ok(pendingClearIndex > managedIndex,
    "RED_TARGET: Trend must clear pending only after managed ownership exists.");
  assert.ok(saveIndex > pendingClearIndex,
    "RED_TARGET: Trend managed ownership must be durable before additive Fixed TP reconcile.");
  assert.ok(filledIndex > saveIndex,
    "RED_TARGET: Trend ENTRY_FILLED must follow durable managed ownership.");
  assert.ok(reconcileIndex > filledIndex,
    "RED_TARGET: Trend must reconcile broker TP from actual fill only after ownership is durable.");
  assert.match(trendSource, /async function reconcileFixedTpBrokerTakeProfit\([\s\S]*?takeProfit\s*:\s*targetPrice[\s\S]*?\/v1\/positions\/\$\{encodeURIComponent\(ticket\)\}/,
    "RED_TARGET: Trend Fixed TP reconcile must PATCH the managed MT5 position with actual-entry-derived targetPrice.");
});

// GREEN rerun marker: production snapshot implementation must satisfy this contract.
