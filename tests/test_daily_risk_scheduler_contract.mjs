// Offline source-contract regression: the entry scheduler must fail closed on missing risk data.
// This test does not start the server or contact MT5.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../scripts/xauusd-standalone-server.mjs", import.meta.url), "utf8");
const gateStart = source.indexOf("const dailyRisk = snap.dailyRiskState;");
const entryStart = source.indexOf("// 1. Nếu đang có lệnh mở", gateStart);

test("new-entry gate rejects missing or malformed daily risk state before DCA", () => {
  assert.ok(gateStart > 0 && entryStart > gateStart, "daily-risk gate precedes DCA");
  const gate = source.slice(gateStart, entryStart);
  for (const fragment of [
    "!dailyRisk",
    'typeof dailyRisk.dailyLimitBreached !== "boolean"',
    "Number.isFinite(dailyRisk.currentDailyLossUsd)",
    "Number.isFinite(dailyRisk.dailyLossLimitUsd)",
    "dailyRisk.dailyLossLimitUsd <= 0",
    "if (dailyRisk.dailyLimitBreached)",
  ]) assert.ok(gate.includes(fragment), "missing fail-closed guard: " + fragment);
  assert.equal((gate.match(/return;/g) || []).length, 2, "invalid and breached states both return");
});
