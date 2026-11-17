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

test("Trend Fixed TP exit reuses canonical trigger, command id, and shared execution lock", () => {
  assert.match(
    trendSource,
    /import\s*\{[\s\S]*?\bisFixedTpTriggered\b[\s\S]*?\bfixedTpCommandId\b[\s\S]*?\}\s*from\s*["']\.\/phase7c-fixed-tp\.mjs["']/,
    "RED_TARGET: Trend must reuse canonical Fixed TP trigger and deterministic command identity.",
  );
  assert.match(
    trendSource,
    /import\s*\{[\s\S]*?\bacquireExecutionLock\b[\s\S]*?\}\s*from\s*["']\.\/phase7c-execution-lock\.mjs["']/,
    "RED_TARGET: Trend Fixed TP close must reuse the shared execution lock.",
  );
});

test("Trend Fixed TP close validates managed identity and closes current remaining volume idempotently", () => {
  const helper = block("async function closeFixedTpIfTriggered(", "async function managePosition(");

  assert.match(helper, /isFixedTpTriggered\s*\(\s*\{[\s\S]*?enabled\s*:\s*managed\.fixedTpEnabled[\s\S]*?side\s*:\s*managed\.side[\s\S]*?targetPrice\s*:\s*managed\.fixedTpPrice[\s\S]*?bid\s*:\s*quote\.bid[\s\S]*?ask\s*:\s*quote\.ask[\s\S]*?\}\s*\)/,
    "RED_TARGET: executable BUY bid / SELL ask trigger must come from the immutable managed snapshot.");
  assert.match(helper, /position\.ticket\s*!==\s*managed\.ticket/,
    "RED_TARGET: Fixed TP must revalidate the managed ticket before mutation.");
  assert.match(helper, /managed\.side\s*===\s*["']BUY["'][\s\S]*?["']LONG["'][\s\S]*?["']SHORT["']/,
    "RED_TARGET: Fixed TP must revalidate managed side against broker position side.");
  assert.match(helper, /Number\.isFinite\s*\(\s*position\.volume\s*\)[\s\S]*?position\.volume\s*>\s*0/,
    "RED_TARGET: Fixed TP must revalidate positive current remaining volume.");
  assert.match(helper, /fixedTpCommandId\s*\(\s*["']trend["']\s*,\s*managed\.ticket\s*\)/,
    "RED_TARGET: command id must be exactly strategy + ticket scoped and retry-stable.");
  assert.match(helper, /acquireExecutionLock\s*\(/,
    "RED_TARGET: close mutation must be protected by the shared execution lock.");
  assert.match(helper, /finally\s*\{[\s\S]*?\.release\s*\(\s*\)/,
    "RED_TARGET: acquired execution lock must always release in finally.");
  assert.match(helper, /post<CommandResponse>\s*\([\s\S]*?\/close[\s\S]*?volume\s*:\s*position\.volume[\s\S]*?commandId/,
    "RED_TARGET: Fixed TP must close 100% of the broker-reconciled remaining volume.");
});

test("Trend Fixed TP lock contention fails closed and terminal outcomes are explicitly observable", () => {
  const helper = block("async function closeFixedTpIfTriggered(", "async function managePosition(");

  for (const event of [
    "FIXED_TP_TRIGGERED",
    "FIXED_TP_CLOSE_ATTEMPT",
    "FIXED_TP_CLOSE_CONFIRMED",
    "FIXED_TP_CLOSE_REPLAY",
    "FIXED_TP_CLOSE_BLOCKED",
  ]) {
    assert.match(helper, new RegExp(`journal\\(["']${event}["']`),
      `RED_TARGET: Trend Fixed TP must journal ${event}.`);
  }
  assert.match(helper, /if\s*\(\s*!lock\.acquired\s*\)[\s\S]*?FIXED_TP_CLOSE_BLOCKED[\s\S]*?return\s+true/,
    "RED_TARGET: lock contention must be handled as a fail-closed Fixed TP cycle with no fall-through mutation.");
  assert.match(helper, /response\.idempotentReplay[\s\S]*?FIXED_TP_CLOSE_REPLAY[\s\S]*?FIXED_TP_CLOSE_CONFIRMED|response\.idempotentReplay[\s\S]*?FIXED_TP_CLOSE_CONFIRMED[\s\S]*?FIXED_TP_CLOSE_REPLAY/,
    "RED_TARGET: replay and first confirmation must remain distinguishable.");
});

test("Trend management preserves +6, +10 and Daily Recovery precedence around Fixed TP", () => {
  const manage = block("async function managePosition(", "async function closeAll(");
  const beIndex = manage.indexOf("if (!managed.breakEvenApplied && favorable >= 6)");
  const recoveryIndex = manage.indexOf("if (managed.dailyMode === \"RECOVERY_TP\")");
  const partialIndex = manage.indexOf("if (!managed.partialApplied && favorable >= 10)");
  const fixedCalls = [...manage.matchAll(/await closeFixedTpIfTriggered\(position,\s*quote\)/g)].map((match) => match.index);
  const guardedFixedCalls = [...manage.matchAll(/if\s*\(\s*await closeFixedTpIfTriggered\(position,\s*quote\)\s*\)\s*return\s*;/g)].map((match) => match.index);

  assert.ok(beIndex >= 0, "existing +6 BE branch must remain present");
  assert.ok(recoveryIndex > beIndex, "Daily Recovery branch must remain after +6 BE");
  assert.ok(partialIndex > recoveryIndex, "existing +10 partial branch must remain after Daily Recovery guard");
  assert.equal(fixedCalls.length, 2,
    "RED_TARGET: Trend must monitor Fixed TP independently in Recovery and in normal native management.");
  assert.equal(guardedFixedCalls.length, fixedCalls.length,
    "RED_TARGET: every Fixed TP monitor call must return immediately when the Fixed TP cycle handled or blocked mutation.");

  const recoveryReturn = manage.indexOf("\n    return;", recoveryIndex);
  assert.ok(fixedCalls[0] > recoveryIndex && fixedCalls[0] < recoveryReturn,
    "RED_TARGET: Recovery TP must keep its broker TP while executor Fixed TP can independently win before recovery return.");
  assert.ok(fixedCalls[1] > partialIndex,
    "RED_TARGET: normal Fixed TP must run after the native +10 branch so targets above +10 preserve one-third partial first.");
});

test("existing Trend non-Fixed-TP full-close command identity stays untouched", () => {
  const closeAll = block("async function closeAll(", "function hasRelevantFvg(");
  assert.match(closeAll, /`p7b-exit-\$\{reason\}-\$\{managed\.ticket\}-\$\{m15CloseTime\}-\$\{managed\.exitAttempt\}`/,
    "existing reversal/runner full-close command identity must not be rewritten by Fixed TP.");
});


test("Trend durable ownership is committed before additive Fixed TP broker reconcile", () => {
  const submit = block("async function submitTrendEntry(", "async function resolveDailyRecoveryPlan(");
  const managedIndex = submit.indexOf("state.managed = {");
  const pendingClearIndex = submit.indexOf("state.pendingEntry = null;", managedIndex);
  const saveIndex = submit.indexOf("saveState();", pendingClearIndex);
  const filledIndex = submit.indexOf('journal("ENTRY_FILLED"', saveIndex);
  const reconcileIndex = submit.indexOf("await reconcileFixedTpBrokerTakeProfit({", filledIndex);

  assert.ok(managedIndex >= 0, "Trend fill must create managed state.");
  assert.ok(pendingClearIndex > managedIndex, "Trend fill must clear pending only after managed ownership exists.");
  assert.ok(saveIndex > pendingClearIndex, "Trend managed ownership must be durable before additive broker TP work.");
  assert.ok(filledIndex > saveIndex, "ENTRY_FILLED must be emitted only after durable ownership.");
  assert.ok(reconcileIndex > filledIndex, "Fixed TP broker reconcile must run after durable ownership and ENTRY_FILLED.");

  const cycle = block("async function cycle()", "async function submitTrendEntry(");
  const pendingIndex = cycle.indexOf("if (state.pendingEntry)");
  const recoveredManagedIndex = cycle.indexOf("state.managed = managedFromPending(", pendingIndex);
  const recoveredClearIndex = cycle.indexOf("state.pendingEntry = null;", recoveredManagedIndex);
  const recoveredSaveIndex = cycle.indexOf("saveState();", recoveredClearIndex);
  const recoveredJournalIndex = cycle.indexOf('journal("PENDING_ENTRY_RECOVERED"', recoveredSaveIndex);
  const recoveredReconcileIndex = cycle.indexOf("await reconcileFixedTpBrokerTakeProfit({", recoveredJournalIndex);

  assert.ok(recoveredManagedIndex > pendingIndex, "Pending recovery must restore managed ownership.");
  assert.ok(recoveredClearIndex > recoveredManagedIndex);
  assert.ok(recoveredSaveIndex > recoveredClearIndex, "Recovered ownership must be durable before broker TP reconcile.");
  assert.ok(recoveredJournalIndex > recoveredSaveIndex);
  assert.ok(recoveredReconcileIndex > recoveredJournalIndex, "Recovered ownership event must precede additive broker TP reconcile.");
});

test("Trend Fixed TP broker reconcile errors are observable but non-fatal", () => {
  const helper = block("async function reconcileFixedTpBrokerTakeProfit(", "function recordManagementExitSideSample(");
  assert.match(helper, /try\s*\{[\s\S]*?patch<CommandResponse>/,
    "Fixed TP broker reconcile must isolate the PATCH call.");
  assert.match(helper, /catch\s*\(error\)[\s\S]*?FIXED_TP_BROKER_RECONCILE_ERROR[\s\S]*?errorMessage\(error\)/,
    "Fixed TP broker reconcile failure must journal an error instead of escaping and breaking ownership lifecycle.");
});
