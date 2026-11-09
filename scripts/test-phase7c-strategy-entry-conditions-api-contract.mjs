import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.resolve(here, "../apps/api/src/routes/phase7c.route.ts");

const {
  Phase7CStrategyEntryConditionsService,
  evaluatePhase7CStrategyEntrySaveGuard,
} = await import("../apps/api/dist/services/phase7c-strategy-entry-conditions.service.js");

function expectCode(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `Expected error code ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase7c-strategy-entry-"));
try {
  const file = path.join(root, "phase7c-strategy-entry-conditions.json");
  const service = new Phase7CStrategyEntryConditionsService(file);

  const initial = service.read();
  assert.equal(initial.valid, true);
  assert.equal(initial.persisted, false);
  assert.equal(initial.error, null);
  assert.equal(initial.state.version, 0);
  assert.equal(initial.state.trend.patternM15, true);
  assert.equal(initial.state.sideway.rangeEdge, true);

  const saved = service.set({
    expectedVersion: 0,
    source: "web-control-center",
    trend: initial.state.trend,
    sideway: { ...initial.state.sideway, m5Confirmation: false },
  });
  assert.equal(saved.valid, true);
  assert.equal(saved.persisted, true);
  assert.equal(saved.state.version, 1);
  assert.equal(saved.state.sideway.m5Confirmation, false);
  assert.equal(saved.state.updatedBy, "web-control-center");
  assert.ok(Number.isFinite(Date.parse(saved.state.updatedAt)));
  assert.equal(fs.existsSync(file), true);

  const completeJson = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(completeJson.version, 1);
  assert.equal(completeJson.trend.patternM15, true);
  assert.equal(completeJson.sideway.rangeEdge, true);
  const tempArtifacts = fs.readdirSync(root).filter((name) => name.includes(".tmp"));
  assert.deepEqual(tempArtifacts, []);

  const beforeStale = fs.readFileSync(file, "utf8");
  expectCode(() => service.set({
    expectedVersion: 0,
    source: "web-control-center",
    trend: saved.state.trend,
    sideway: saved.state.sideway,
  }), "CONFIG_VERSION_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), beforeStale);

  const beforeSource = fs.readFileSync(file, "utf8");
  expectCode(() => service.set({
    expectedVersion: 1,
    source: "other-client",
    trend: saved.state.trend,
    sideway: saved.state.sideway,
  }), "ENTRY_STRATEGY_CONFIG_INVALID");
  assert.equal(fs.readFileSync(file, "utf8"), beforeSource);

  const beforeTrendAnchor = fs.readFileSync(file, "utf8");
  expectCode(() => service.set({
    expectedVersion: 1,
    source: "web-control-center",
    trend: { ...saved.state.trend, patternM15: false },
    sideway: saved.state.sideway,
  }), "ENTRY_STRATEGY_CONFIG_INVALID");
  assert.equal(fs.readFileSync(file, "utf8"), beforeTrendAnchor);

  const beforeSidewayAnchor = fs.readFileSync(file, "utf8");
  expectCode(() => service.set({
    expectedVersion: 1,
    source: "web-control-center",
    trend: saved.state.trend,
    sideway: { ...saved.state.sideway, rangeEdge: false },
  }), "ENTRY_STRATEGY_CONFIG_INVALID");
  assert.equal(fs.readFileSync(file, "utf8"), beforeSidewayAnchor);

  const beforeUnknown = fs.readFileSync(file, "utf8");
  expectCode(() => service.set({
    expectedVersion: 1,
    source: "web-control-center",
    trend: saved.state.trend,
    sideway: saved.state.sideway,
    threshold: 123,
  }), "ENTRY_STRATEGY_CONFIG_INVALID");
  assert.equal(fs.readFileSync(file, "utf8"), beforeUnknown);

  const malformedFile = path.join(root, "malformed.json");
  fs.writeFileSync(malformedFile, "{not-json\n", "utf8");
  const malformedService = new Phase7CStrategyEntryConditionsService(malformedFile);
  const malformed = malformedService.read();
  assert.equal(malformed.valid, false);
  assert.equal(malformed.persisted, true);
  assert.equal(malformed.state, null);
  assert.ok(malformed.error);
  const malformedBefore = fs.readFileSync(malformedFile, "utf8");
  expectCode(() => malformedService.set({
    expectedVersion: 0,
    source: "web-control-center",
    trend: initial.state.trend,
    sideway: initial.state.sideway,
  }), "ENTRY_STRATEGY_CONFIG_INVALID");
  assert.equal(fs.readFileSync(malformedFile, "utf8"), malformedBefore);

  const guardCases = [
    [
      { mode: "AUTO", accountStateValid: true, bridgeReachable: true, accountModeMatches: true, openXauusdPositions: 0 },
      "STRATEGY_PROFILE_EDIT_REQUIRES_PAUSE",
    ],
    [
      { mode: "PAUSE", accountStateValid: false, bridgeReachable: true, accountModeMatches: true, openXauusdPositions: 0 },
      "ACCOUNT_STATE_INVALID",
    ],
    [
      { mode: "PAUSE", accountStateValid: true, bridgeReachable: false, accountModeMatches: true, openXauusdPositions: 0 },
      "BRIDGE_TELEMETRY_UNAVAILABLE",
    ],
    [
      { mode: "PAUSE", accountStateValid: true, bridgeReachable: true, accountModeMatches: false, openXauusdPositions: 0 },
      "ACCOUNT_MODE_MISMATCH",
    ],
    [
      { mode: "PAUSE", accountStateValid: true, bridgeReachable: true, accountModeMatches: true, openXauusdPositions: null },
      "XAUUSD_POSITION_COUNT_UNKNOWN",
    ],
    [
      { mode: "PAUSE", accountStateValid: true, bridgeReachable: true, accountModeMatches: true, openXauusdPositions: 1 },
      "XAUUSD_POSITIONS_OPEN",
    ],
  ];

  for (const [input, expectedCode] of guardCases) {
    const result = evaluatePhase7CStrategyEntrySaveGuard(input);
    assert.equal(result.allowed, false);
    assert.equal(result.httpStatus, 409);
    assert.equal(result.code, expectedCode);
    assert.ok(result.message);
  }

  assert.deepEqual(
    evaluatePhase7CStrategyEntrySaveGuard({
      mode: "PAUSE",
      accountStateValid: true,
      bridgeReachable: true,
      accountModeMatches: true,
      openXauusdPositions: 0,
    }),
    { allowed: true },
  );

  const routeSource = fs.readFileSync(routePath, "utf8");
  assert.match(routeSource, /phase7CStrategyEntryConditionsService/);
  assert.match(routeSource, /evaluatePhase7CStrategyEntrySaveGuard/);
  assert.match(routeSource, /Phase7CStrategyEntryConfigError/);
  assert.match(routeSource, /router\.get\("\/strategy-entry-conditions"/);
  assert.match(routeSource, /router\.post\("\/strategy-entry-conditions"/);
  assert.match(routeSource, /canChangeBotMode\(req\)/);
  assert.match(routeSource, /appliesTo:\s*"NEW_ENTRIES_ONLY"/);
  assert.match(routeSource, /sharedAcrossAccounts:\s*true/);
  assert.match(routeSource, /mandatory:\s*\{[\s\S]*trend:\s*\["patternM15"\][\s\S]*sideway:\s*\["rangeEdge"\]/);
  assert.match(routeSource, /requiresPause:\s*true/);
  assert.match(routeSource, /requiresZeroXauusdPositions:\s*true/);
  assert.match(routeSource, /editable:\s*read\.valid\s*&&\s*guard\.allowed/);
  assert.match(routeSource, /getMt5Telemetry\("XAUUSD"\)/);
  assert.match(routeSource, /accountModeAllowsBroker/);
  assert.match(routeSource, /openXauusdPositions/);
  assert.match(routeSource, /status\(403\)/);
  assert.match(routeSource, /CONFIG_VERSION_CONFLICT/);
  assert.match(routeSource, /status\(409\)/);
  assert.match(routeSource, /status\(400\)/);

  const guardHelperSection = routeSource.slice(
    routeSource.indexOf("async function getStrategyEntryConditionGuards"),
    routeSource.indexOf('router.get("/account-mode"'),
  );
  assert.ok(guardHelperSection.length > 0, "strategy entry telemetry guard helper must exist");
  assert.match(guardHelperSection, /catch[\s\S]*bridgeReachable:\s*false/);
  assert.match(guardHelperSection, /accountModeMatches:\s*false/);
  assert.match(guardHelperSection, /openXauusdPositions:\s*null/);

  const strategyRouteSection = routeSource.slice(
    routeSource.indexOf('router.get("/strategy-entry-conditions"'),
    routeSource.indexOf('router.get("/live-regime"'),
  );
  assert.ok(strategyRouteSection.length > 0, "strategy entry route section must exist before live-regime route");
  assert.doesNotMatch(strategyRouteSection, /status\(503\)/);
  assert.match(strategyRouteSection, /if\s*\(!read\.valid\)[\s\S]*status\(409\)/);
  assert.match(strategyRouteSection, /phase7CStrategyEntryConditionsService\.set\(req\.body\)/);

  console.log("PHASE7C_STRATEGY_ENTRY_API_PERSISTENCE_CONTRACT=PASS");
  console.log("PHASE7C_STRATEGY_ENTRY_API_ROUTE_CONTRACT=PASS");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
