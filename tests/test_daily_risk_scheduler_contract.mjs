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
const runGate = new Function("snap", "autoBotState", "probeStartUtc", gate + "\nreturn true;");
const now = Math.floor(Date.now() / 1000);
const valid = { ok: true, updatedAtUtc: now, dailyLimitBreached: false,
  currentDailyLossUsd: 20, dailyLossLimitUsd: 100 };
function permitsEntry(dailyRiskState) {
  const state = { lastLog: "", lastRiskWarning: "" };
  const allowed = runGate({ dailyRiskState }, state, now) === true;
  return { allowed, state };
}

test("only fresh, verified, unbreached daily state permits Auto/DCA evaluation", () => {
  assert.equal(permitsEntry(valid).allowed, true);
  for (const invalid of [
    undefined, null, [], {},
    { ...valid, updatedAtUtc: now - 1 },
    { ...valid, currentDailyLossUsd: -1 },
    { ...valid, currentDailyLossUsd: 100 },
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

test("monitor resumes Auto and DCA only after a fresh probe following disconnect", async () => {
  const { runInNewContext } = await import("node:vm");
  const start = source.indexOf("function startV6BackgroundMonitor()");
  const end = source.indexOf("}, SIGNAL_SCAN_INTERVAL_MS);", start);
  const monitor = source.slice(start, source.indexOf("\n}", end) + 2);
  for (const action of ["order", "dca_plus"]) {
    const requests = [];
    let snapshot;
    const tick = runInNewContext(monitor + "\nstartV6BackgroundMonitor()", {
      Date: {now: () => now * 1000},
      startV6PositionManagementLoop() {}, setInterval: fn => fn, SIGNAL_SCAN_INTERVAL_MS: 6000,
      v6MonitorBusy: false, knownClosedTickets: new Set(), trackedOpenPositionsMap: new Map(),
      getCanonicalLiveArmState: () => ({liveArmed: true}), getCanonicalFixedLot: () => 0.01,
      getActiveBotDisplayName: () => "mock", previousEntryKey: "", persistEntryKey() {},
      autoBotState: {enabled: true, strategyMode: "AUTO_REGIME", minConfidence: 1, lastActionTime: 0},
      positiveDcaConfig: {enabled: true, lastDcaTime: 0}, trendManagementConfig: {},
      console: {error: message => assert.fail(String(message))},
      invokeMt5PythonEngine: async req => {
        if (req.action === "probe") return snapshot;
        requests.push(req.action);
        return {};
      }
    });
    snapshot = {connected: false};
    await tick();
    snapshot = {connected: true, accountMode: "LIVE", accountLogin: 1,
      openPositions: action === "order" ? [] : [{ticket: 123}],
      entrySignal: {allowed: true, side: "BUY", setupScore: 90, closedM15Time: 1}};
    for (const risk of [null, {...valid, updatedAtUtc: now - 60}, {...valid, dailyLimitBreached: true}]) {
      snapshot.dailyRiskState = risk;
      await tick();
      assert.deepEqual(requests, []);
    }
    snapshot.dailyRiskState = valid;
    await tick();
    assert.deepEqual(requests, [action]);
  }
});
