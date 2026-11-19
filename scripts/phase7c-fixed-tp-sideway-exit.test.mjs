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

test("Sideway Fixed TP exit reuses canonical executable trigger, deterministic command id, and shared execution lock", () => {
  assert.match(
    sidewaySource,
    /import\s*\{[\s\S]*?\bbuildFixedTpSnapshot\b[\s\S]*?\bisFixedTpTriggered\b[\s\S]*?\bfixedTpCommandId\b[\s\S]*?\}\s*from\s*["']\.\/phase7c-fixed-tp\.mjs["']/,
    "RED_TARGET: Sideway must reuse canonical Fixed TP snapshot, bid/ask trigger and deterministic command identity.",
  );
  assert.match(
    sidewaySource,
    /import\s*\{[\s\S]*?\bacquireExecutionLock\b[\s\S]*?\}\s*from\s*["']\.\/phase7c-execution-lock\.mjs["']/,
    "RED_TARGET: Sideway Fixed TP close must reuse the shared execution lock.",
  );
});

test("Sideway Fixed TP close re-reconciles managed identity and closes 100% of current remaining broker volume", () => {
  const helper = block("async function closeFixedTpIfTriggered(", "async function managePosition(");

  assert.match(helper, /bridgeGet\s*\(\s*`\/v1\/positions\?symbol=\$\{encodeURIComponent\(symbol\)\}`\s*,?\s*\)/,
    "RED_TARGET: Fixed TP helper must reconcile the current broker position again so a same-cycle +10 partial cannot leave stale volume.");
  assert.match(helper, /positions\.length\s*!==\s*1/,
    "RED_TARGET: ambiguous broker position state must fail closed.");
  assert.match(helper, /isFixedTpTriggered\s*\(\s*\{[\s\S]*?enabled\s*:\s*managed\.fixedTpEnabled[\s\S]*?side\s*:\s*managed\.side[\s\S]*?targetPrice\s*:\s*managed\.fixedTpPrice[\s\S]*?bid\s*:\s*quote\.bid[\s\S]*?ask\s*:\s*quote\.ask[\s\S]*?\}\s*\)/,
    "RED_TARGET: BUY must trigger from bid and SELL from ask using the immutable managed target.");
  assert.match(helper, /position\.ticket\s*!==\s*managed\.ticket/,
    "RED_TARGET: Fixed TP must revalidate the managed ticket before mutation.");
  assert.match(helper, /managed\.side\s*===\s*["']BUY["'][\s\S]*?["']LONG["'][\s\S]*?["']SHORT["']/,
    "RED_TARGET: Fixed TP must revalidate managed side against broker position side.");
  assert.match(helper, /Number\.isFinite\s*\(\s*Number\(position\.volume\)\s*\)[\s\S]*?Number\(position\.volume\)\s*>\s*0|Number\.isFinite\s*\(\s*position\.volume\s*\)[\s\S]*?position\.volume\s*>\s*0/,
    "RED_TARGET: Fixed TP must revalidate a positive current remaining volume.");
  assert.match(helper, /fixedTpCommandId\s*\(\s*["']sideway["']\s*,\s*managed\.ticket\s*\)/,
    "RED_TARGET: duplicate polling/restart must reuse exactly phase7c-fixed-tp-sideway-{ticket}.");
  assert.match(helper, /bridgeRequest\s*\(\s*["']POST["'][\s\S]*?\/close[\s\S]*?volume\s*:\s*Number\(position\.volume\)|bridgeRequest\s*\(\s*["']POST["'][\s\S]*?\/close[\s\S]*?volume\s*:\s*position\.volume/,
    "RED_TARGET: Fixed TP must close 100% of the broker-reconciled remaining volume.");
});

test("Sideway Fixed TP lock contention fails closed and confirmed/replay outcomes remain observable", () => {
  const helper = block("async function closeFixedTpIfTriggered(", "async function managePosition(");

  assert.match(helper, /acquireExecutionLock\s*\(/,
    "RED_TARGET: Fixed TP mutation must acquire the shared lock immediately around close execution.");
  assert.match(helper, /if\s*\(\s*!lock\.acquired\s*\)[\s\S]*?FIXED_TP_CLOSE_BLOCKED[\s\S]*?return\s+true/,
    "RED_TARGET: lock contention must fail closed with no fall-through broker mutation.");
  assert.match(helper, /finally\s*\{[\s\S]*?lock\.release\s*\(\s*\)/,
    "RED_TARGET: acquired execution lock must always release in finally.");

  for (const event of [
    "FIXED_TP_TRIGGERED",
    "FIXED_TP_CLOSE_ATTEMPT",
    "FIXED_TP_CLOSE_CONFIRMED",
    "FIXED_TP_CLOSE_REPLAY",
    "FIXED_TP_CLOSE_BLOCKED",
  ]) {
    assert.match(helper, new RegExp(`journal\\(["']${event}["']`),
      `RED_TARGET: Sideway Fixed TP must journal ${event}.`);
  }
  assert.match(helper, /response\.idempotentReplay[\s\S]*?FIXED_TP_CLOSE_REPLAY[\s\S]*?FIXED_TP_CLOSE_CONFIRMED|response\.idempotentReplay[\s\S]*?FIXED_TP_CLOSE_CONFIRMED[\s\S]*?FIXED_TP_CLOSE_REPLAY/,
    "RED_TARGET: first confirmation and deterministic replay must remain distinguishable.");
});

test("Sideway broker-native Fixed TP/SL cannot be overridden by obsolete software exits", () => {
  const manage = block("async function managePosition(", "async function closeAll(");
  assert.match(sidewaySource, /const brokerTpSlTrailOnly = true;/);

  const legacyTimeGuard = manage.indexOf("if (!brokerTpSlTrailOnly) {");
  const timeIndex = manage.indexOf("if (Date.now() >= managed.timeStopAt)");
  const regimeIndex = manage.indexOf('await closeAll(position, "REGIME_LEFT_RANGE")');
  const breakEvenIndex = manage.indexOf("if (!managed.breakEvenApplied && favorable >= 6)");
  const recoveryIndex = manage.indexOf('if (managed.dailyMode === "RECOVERY_TP")');
  const partialIndex = manage.indexOf("if (!brokerTpSlTrailOnly && managed.breakEvenApplied && !managed.partialApplied && targetReached(");
  const holdIndex = manage.indexOf('journal("SIDEWAY_HOLD_BROKER_TP_SL_TRAIL_ONLY"');
  const finalFixedIndex = manage.lastIndexOf("if (await closeFixedTpIfTriggered(position, quote)) return;");
  const tp2Index = manage.indexOf("if (targetReached(managed.side, marketPrice, managed.tp2))");

  assert.ok(legacyTimeGuard >= 0 && timeIndex > legacyTimeGuard && regimeIndex > timeIndex,
    "TIME_STOP and REGIME_LEFT_RANGE must be inaccessible under the locked post-fill policy");
  assert.ok(breakEvenIndex > regimeIndex,
    "BE/SL tightening remains reachable outside the legacy close guard");
  assert.match(manage.slice(breakEvenIndex, partialIndex),
    /if \(!brokerTpSlTrailOnly\)\s*\{\s*if \(managed\.dailyMode === "RECOVERY_TP"\)/,
    "legacy Recovery software close must be unreachable during broker-only management");
  assert.ok(partialIndex > recoveryIndex && holdIndex > partialIndex,
    "the entire one-third partial branch must require broker-only policy OFF");
  assert.ok(finalFixedIndex > holdIndex && tp2Index > finalFixedIndex,
    "broker-only HOLD returns before any discretionary Fixed TP or TP2 fallback close");
  assert.match(manage.slice(holdIndex, finalFixedIndex), /\breturn\s*;/,
    "broker-native TP/SL-only management must unconditionally return before legacy exits");
  assert.equal([...manage.matchAll(/await closeFixedTpIfTriggered\(position,\s*quote\)/g)].length, 2,
    "retain the legacy helper solely for backward-compatible source contracts without calling it");
});


test("existing Sideway native close paths and command identity stay untouched", () => {
  const closeAll = block("async function closeAll(", "async function controlGet(");
  assert.match(closeAll, /managed\.exitAttempt\s*\+=\s*1/,
    "existing native Sideway full-close attempt tracking must remain unchanged.");
  assert.match(closeAll, /commandId\s*:\s*`p7c-sideway-exit-\$\{managed\.ticket\}-\$\{managed\.exitAttempt\}`/,
    "existing TP2/range/time/regime close identity must not be rewritten by Fixed TP.");
  assert.match(sidewaySource, /tp2\s*:\s*executionPlan\.takeProfit/,
    "existing durable Sideway TP2 metadata must remain unchanged by broker-native Fixed TP.");
  assert.match(sidewaySource, /const\s+brokerTakeProfit\s*=\s*dailyRecovery\.mode\s*===\s*["']RECOVERY_TP["'][\s\S]*?executionPlan\.takeProfit[\s\S]*?fixedTpSnapshot\.enabled[\s\S]*?fixedTpSnapshot\.targetPrice[\s\S]*?executionPlan\.takeProfit/,
    "Daily Recovery must keep broker TP precedence while non-Recovery Fixed TP may become the broker-native takeProfit.");
  assert.match(sidewaySource, /takeProfit\s*:\s*brokerTakeProfit/,
    "initial Sideway broker order must use the canonical brokerTakeProfit selector.");
});


test("Sideway durable ownership is committed before additive Fixed TP broker reconcile", () => {
  const cycle = block("async function cycle()", "function readStrategyEntryConfigSnapshot()");

  const pendingIndex = cycle.indexOf("if (!state.managed && state.pendingEntry)");
  const recoveredManagedIndex = cycle.indexOf("state.managed = buildManagedState(recovery.position", pendingIndex);
  const recoveredClearIndex = cycle.indexOf("state.pendingEntry = null;", recoveredManagedIndex);
  const recoveredSaveIndex = cycle.indexOf("saveState();", recoveredClearIndex);
  const recoveredJournalIndex = cycle.indexOf('journal("PENDING_ENTRY_RECOVERED"', recoveredSaveIndex);
  const recoveredReconcileIndex = cycle.indexOf("await reconcileFixedTpBrokerTakeProfit({", recoveredJournalIndex);

  assert.ok(recoveredManagedIndex > pendingIndex, "Sideway pending recovery must restore managed ownership.");
  assert.ok(recoveredClearIndex > recoveredManagedIndex);
  assert.ok(recoveredSaveIndex > recoveredClearIndex, "Recovered Sideway ownership must be durable before broker TP reconcile.");
  assert.ok(recoveredJournalIndex > recoveredSaveIndex);
  assert.ok(recoveredReconcileIndex > recoveredJournalIndex, "Sideway recovery event must precede additive broker TP reconcile.");

  const submitManagedIndex = cycle.lastIndexOf("state.managed = buildManagedState(opened");
  const submitClearIndex = cycle.indexOf("state.pendingEntry = null;", submitManagedIndex);
  const submitSaveIndex = cycle.indexOf("saveState();", submitClearIndex);
  const filledIndex = cycle.indexOf('journal("ENTRY_FILLED"', submitSaveIndex);
  const reconcileIndex = cycle.indexOf("await reconcileFixedTpBrokerTakeProfit({", filledIndex);

  assert.ok(submitManagedIndex >= 0, "Sideway fill must create managed state.");
  assert.ok(submitClearIndex > submitManagedIndex);
  assert.ok(submitSaveIndex > submitClearIndex, "Sideway managed ownership must be durable before broker TP reconcile.");
  assert.ok(filledIndex > submitSaveIndex, "Sideway ENTRY_FILLED must follow durable ownership.");
  assert.ok(reconcileIndex > filledIndex, "Sideway Fixed TP broker reconcile must run after durable ownership and ENTRY_FILLED.");
});

test("Sideway Fixed TP broker reconcile errors are observable but non-fatal", () => {
  const helper = block("async function reconcileFixedTpBrokerTakeProfit(", "async function closeFixedTpIfTriggered(");
  assert.match(helper, /try\s*\{[\s\S]*?bridgeRequest\s*\(\s*["']PATCH["']/,
    "Sideway Fixed TP broker reconcile must isolate the PATCH call.");
  assert.match(helper, /catch\s*\(error\)[\s\S]*?FIXED_TP_BROKER_RECONCILE_ERROR[\s\S]*?errorMessage\(error\)/,
    "Sideway Fixed TP broker reconcile failure must journal an error instead of escaping and breaking ownership lifecycle.");
});
