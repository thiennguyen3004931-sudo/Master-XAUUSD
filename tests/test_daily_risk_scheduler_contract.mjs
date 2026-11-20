// Offline behavioral test: execute the scheduler's actual risk gate in isolation.
// No server, MT5 module, network or order_send is loaded.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/xauusd-standalone-server.mjs", import.meta.url), "utf8");
const gateStart = source.indexOf("const dailyRisk = snap.dailyRiskState;");
const entryStart = source.indexOf("// 1. Nếu đang có lệnh mở", gateStart);
assert.ok(gateStart > 0 && entryStart > gateStart, "daily risk gate precedes DCA");
const gate = source.slice(gateStart, entryStart);
// Wrap the extracted real gate in a function so 'return' has the same semantics.
const runGate = new Function("snap", "autoBotState", gate + "\nreturn true;");
const now = Math.floor(Date.now() / 1000);
const valid = { ok: true, updatedAtUtc: now, dailyLimitBreached: false,
  currentDailyLossUsd: 20, dailyLossLimitUsd: 100 };
function permitsEntry(dailyRiskState) {
  const state = { lastLog: "", lastRiskWarning: "" };
  const allowed = runGate({ dailyRiskState }, state) === true;
  return { allowed, state };
}

test("only fresh, verified, unbreached daily state permits Auto/DCA evaluation", () => {
  assert.equal(permitsEntry(valid).allowed, true);
  for (const invalid of [
    undefined, null, [], {},
    { ...valid, ok: false },
    { ...valid, updatedAtUtc: now - 31 },
    { ...valid, updatedAtUtc: now + 31 },
    { ...valid, updatedAtUtc: null },
    { ...valid, dailyLimitBreached: undefined },
    { ...valid, dailyLimitBreached: "false" },
    { ...valid, currentDailyLossUsd: NaN },
    { ...valid, dailyLossLimitUsd: 0 },
    { ...valid, dailyLimitBreached: true },
  ]) {
    const result = permitsEntry(invalid);
    assert.equal(result.allowed, false, "unverified or breached state must block");
    assert.ok(result.state.lastRiskWarning.length > 0);
  }
});
