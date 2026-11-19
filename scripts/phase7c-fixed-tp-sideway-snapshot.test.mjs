import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const sidewaySource = readFileSync(path.join(scriptsDir, "run-phase7c-sideway-controller.mjs"), "utf8");

function block(startMarker, endMarker) {
  const start = sidewaySource.indexOf(startMarker);
  assert.notEqual(start, -1, `source must contain ${startMarker}`);
  const end = sidewaySource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `source must contain ${endMarker} after ${startMarker}`);
  return sidewaySource.slice(start, end);
}

test("Sideway controller consumes only canonical Sideway Fixed TP runtime configuration", () => {
  assert.match(
    sidewaySource,
    /import\s*\{[\s\S]*?\bbuildFixedTpSnapshot\b[\s\S]*?\}\s*from\s*["']\.\/phase7c-fixed-tp\.mjs["']/,
    "RED_TARGET: Sideway must reuse the canonical pure Fixed TP snapshot helper.",
  );
  assert.match(sidewaySource, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_ENABLED/,
    "RED_TARGET: Sideway controller must read Sideway Fixed TP enable from the canonical launcher env.");
  assert.match(sidewaySource, /ZIQ_PHASE7C_SIDEWAY_FIXED_TP_DISTANCE/,
    "RED_TARGET: Sideway controller must read Sideway Fixed TP distance from the canonical launcher env.");
  assert.doesNotMatch(sidewaySource, /ZIQ_PHASE7C_TREND_FIXED_TP_/,
    "Sideway controller must never consume Trend Fixed TP configuration.");
});

test("Sideway durable pending entry snapshots Fixed TP before broker submission", () => {
  const entryFlow = block("const dailyRecovery = await resolveDailyRecoveryPlan(", "const order = await bridgeRequest(\"POST\", \"/v1/orders\"");
  const pendingIndex = entryFlow.indexOf("state.pendingEntry = {");
  const saveIndex = entryFlow.indexOf("saveState();", pendingIndex);
  const orderBoundary = entryFlow.length;

  assert.match(entryFlow, /buildFixedTpSnapshot\s*\(\s*\{[\s\S]*?enabled\s*:\s*sidewayFixedTpEnabled[\s\S]*?distance\s*:\s*sidewayFixedTpDistance[\s\S]*?side[\s\S]*?entry\s*:\s*Number\(finalPlan\.entry\)[\s\S]*?\}\s*\)/,
    "RED_TARGET: Fixed TP must be snapshotted from Sideway runtime settings and planned entry before durable pending state.");
  assert.ok(pendingIndex >= 0 && saveIndex > pendingIndex && saveIndex < orderBoundary,
    "existing pending state must remain durable before broker submission");

  const pendingBlock = entryFlow.slice(pendingIndex, saveIndex);
  assert.match(pendingBlock, /fixedTpEnabled\s*:\s*fixedTpSnapshot\.enabled/,
    "RED_TARGET: pending state must persist fixedTpEnabled.");
  assert.match(pendingBlock, /fixedTpDistance\s*:\s*fixedTpSnapshot\.distance/,
    "RED_TARGET: pending state must persist fixedTpDistance.");
  assert.match(pendingBlock, /fixedTpPrice\s*:\s*fixedTpSnapshot\.targetPrice/,
    "RED_TARGET: pending state must persist entry-derived fixedTpPrice.");
  assert.match(entryFlow, /journal\s*\(\s*["']FIXED_TP_CONFIG_SNAPSHOT["']/,
    "RED_TARGET: Sideway entry must journal the immutable Fixed TP snapshot.");
});

test("Sideway fill and pending recovery derive managed Fixed TP from actual broker entry", () => {
  const managedBuilder = block("function buildManagedState(", "async function managePosition(");

  assert.match(managedBuilder, /buildFixedTpSnapshot\s*\(\s*\{[\s\S]*?enabled\s*:\s*pending\.fixedTpEnabled[\s\S]*?distance\s*:\s*pending\.fixedTpDistance[\s\S]*?side\s*:\s*pending\.side[\s\S]*?entry\s*:\s*Number\(opened\.entry\)[\s\S]*?\}\s*\)/,
    "RED_TARGET: fill/recovery must rederive target from actual broker entry while keeping the pending configuration snapshot.");
  assert.match(managedBuilder, /fixedTpEnabled\s*:\s*fixedTpSnapshot\.enabled/,
    "RED_TARGET: managed state must persist fixedTpEnabled.");
  assert.match(managedBuilder, /fixedTpDistance\s*:\s*fixedTpSnapshot\.distance/,
    "RED_TARGET: managed state must persist fixedTpDistance.");
  assert.match(managedBuilder, /fixedTpPrice\s*:\s*fixedTpSnapshot\.targetPrice/,
    "RED_TARGET: managed state must persist the actual-entry-derived target across restart.");

  assert.match(sidewaySource, /state\.managed\s*=\s*buildManagedState\(recovery\.position,\s*pending,\s*brokerClockOffsetMs\)/,
    "pending-entry recovery must use the same managed-state builder as a normal fill.");
  assert.match(sidewaySource, /state\.managed\s*=\s*buildManagedState\(opened,\s*state\.pendingEntry,\s*brokerClockOffsetMs\)/,
    "normal fill must use the canonical managed-state builder.");
});

test("legacy Sideway persisted state restores Fixed TP disabled without changing saved v1 state contract", () => {
  const loadState = block("function loadState()", "function saveState()");

  assert.match(loadState, /normalizePendingEntry\s*\(\s*parsed\.pendingEntry\s*\)/,
    "RED_TARGET: persisted pending state must pass through a legacy-safe Fixed TP normalizer.");
  assert.match(loadState, /normalizeManagedState\s*\(\s*parsed\.managed\s*\)/,
    "RED_TARGET: persisted managed state must pass through a legacy-safe Fixed TP normalizer.");

  const pendingNormalizer = block("function normalizePendingEntry(", "function normalizeManagedState(");
  assert.match(pendingNormalizer, /fixedTpEnabled\s*:\s*fixedTpEnabled\s*\?\s*true\s*:\s*false/,
    "RED_TARGET: old pending state without valid Fixed TP fields must restore disabled.");
  assert.match(pendingNormalizer, /fixedTpDistance\s*:\s*fixedTpEnabled\s*\?\s*distance\s*:\s*0/,
    "RED_TARGET: old pending state must restore distance 0.");
  assert.match(pendingNormalizer, /fixedTpPrice\s*:\s*fixedTpEnabled\s*\?\s*price\s*:\s*null/,
    "RED_TARGET: old pending state must restore target null.");

  const managedNormalizer = block("function normalizeManagedState(", "function loadState()");
  assert.match(managedNormalizer, /fixedTpEnabled\s*:\s*fixedTpEnabled\s*\?\s*true\s*:\s*false/,
    "RED_TARGET: old managed state without valid Fixed TP fields must restore disabled.");
  assert.match(managedNormalizer, /fixedTpDistance\s*:\s*fixedTpEnabled\s*\?\s*distance\s*:\s*0/,
    "RED_TARGET: old managed state must restore distance 0.");
  assert.match(managedNormalizer, /fixedTpPrice\s*:\s*fixedTpEnabled\s*\?\s*price\s*:\s*null/,
    "RED_TARGET: old managed state must restore target null.");

  assert.match(loadState, /version\s*:\s*1/,
    "Sideway local state version must stay compatible; change is additive state normalization, not a state-format reset.");
});

test("Sideway sends Fixed TP to MT5 on initial non-Recovery order and preserves canonical Recovery TP precedence", () => {
  const entryFlow = block("const fixedTpSnapshot = buildFixedTpSnapshot({", "if (!order.accepted) {");
  assert.match(entryFlow, /const\s+brokerTakeProfit\s*=\s*dailyRecovery\.mode\s*===\s*["']RECOVERY_TP["'][\s\S]*?executionPlan\.takeProfit[\s\S]*?fixedTpSnapshot\.enabled[\s\S]*?fixedTpSnapshot\.targetPrice[\s\S]*?executionPlan\.takeProfit/,
    "RED_TARGET: non-Recovery Sideway orders with Fixed TP enabled must send the Fixed TP target to MT5 while Recovery keeps canonical Recovery TP.");
  assert.match(entryFlow, /takeProfit\s*:\s*brokerTakeProfit/,
    "RED_TARGET: Sideway initial /v1/orders payload must use brokerTakeProfit.");
  assert.match(entryFlow, /tp2\s*:\s*executionPlan\.takeProfit/,
    "Sideway native TP2 management metadata must remain unchanged.");
});

test("Sideway verifies actual fill, commits ownership, then reconciles broker Fixed TP", () => {
  const fillFlow = block(
    "state.managed = buildManagedState(opened, state.pendingEntry, brokerClockOffsetMs);",
    "function readStrategyEntryConfigSnapshot()",
  );
  const managedIndex = fillFlow.indexOf("state.managed = buildManagedState(opened, state.pendingEntry, brokerClockOffsetMs);");
  const pendingClearIndex = fillFlow.indexOf("state.pendingEntry = null;", managedIndex);
  const saveIndex = fillFlow.indexOf("saveState();", pendingClearIndex);
  const filledIndex = fillFlow.indexOf('journal("ENTRY_FILLED"', saveIndex);
  const reconcileIndex = fillFlow.indexOf("await reconcileFixedTpBrokerTakeProfit({", filledIndex);

  assert.ok(managedIndex >= 0,
    "RED_TARGET: Sideway actual fill must create managed ownership.");
  assert.ok(pendingClearIndex > managedIndex,
    "RED_TARGET: Sideway must clear pending only after managed ownership exists.");
  assert.ok(saveIndex > pendingClearIndex,
    "RED_TARGET: Sideway managed ownership must be durable before additive Fixed TP reconcile.");
  assert.ok(filledIndex > saveIndex,
    "RED_TARGET: Sideway ENTRY_FILLED must follow durable managed ownership.");
  assert.ok(reconcileIndex > filledIndex,
    "RED_TARGET: Sideway must reconcile broker TP from actual fill only after ownership is durable.");
  assert.match(sidewaySource, /async function reconcileFixedTpBrokerTakeProfit\([\s\S]*?takeProfit\s*:\s*targetPrice[\s\S]*?\/v1\/positions\/\$\{encodeURIComponent\(ticket\)\}/,
    "RED_TARGET: Sideway Fixed TP reconcile must PATCH the managed MT5 position with actual-entry-derived targetPrice.");
});
