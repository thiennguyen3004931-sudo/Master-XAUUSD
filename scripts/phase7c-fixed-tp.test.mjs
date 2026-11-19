import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Phase7CLotSettingsService,
  validatePhase7CLotSettings,
} from "../apps/api/dist/services/phase7c-lot-settings.service.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const fixedTpModulePath = path.join(scriptsDir, "phase7c-fixed-tp.mjs");

async function loadFixedTpModule() {
  assert.equal(
    existsSync(fixedTpModulePath),
    true,
    "RED_TARGET: scripts/phase7c-fixed-tp.mjs must provide the executor-owned Fixed TP contract.",
  );
  return import(`${pathToFileURL(fixedTpModulePath).href}?t=${Date.now()}`);
}

test("lot settings default to schema v2 with Fixed TP disabled", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-fixed-tp-default-"));
  try {
    const service = new Phase7CLotSettingsService(
      path.join(root, "settings.json"),
      path.join(root, "active.json"),
    );
    const state = service.getState();
    assert.equal(state.version, 2, "RED_TARGET: Phase7C lot settings must upgrade to schema v2.");
    assert.equal(state.trendFixedTpEnabled, false);
    assert.equal(state.trendFixedTpDistance, 0);
    assert.equal(state.sidewayFixedTpEnabled, false);
    assert.equal(state.sidewayFixedTpDistance, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v1 settings migrate in memory without changing lot values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "phase7c-fixed-tp-migrate-"));
  try {
    const settingsPath = path.join(root, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify({
      version: 1,
      trendFixedLot: 0.12,
      sidewayRiskPercent: 0.4,
      sidewayMaxLot: 0.3,
      updatedAt: "2026-08-31T00:00:00.000Z",
      updatedBy: "legacy-v1",
    })}\n`, "utf8");

    const service = new Phase7CLotSettingsService(
      settingsPath,
      path.join(root, "active.json"),
    );
    const state = service.getState();
    assert.equal(state.version, 2, "RED_TARGET: persisted v1 settings must canonicalize to schema v2.");
    assert.equal(state.trendFixedLot, 0.12);
    assert.equal(state.sidewayRiskPercent, 0.4);
    assert.equal(state.sidewayMaxLot, 0.3);
    assert.equal(state.trendFixedTpEnabled, false);
    assert.equal(state.trendFixedTpDistance, 0);
    assert.equal(state.sidewayFixedTpEnabled, false);
    assert.equal(state.sidewayFixedTpDistance, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Fixed TP settings validate independently and remain backward compatible", () => {
  assert.deepEqual(
    validatePhase7CLotSettings({
      trendFixedLot: 0.12,
      sidewayRiskPercent: 0.4,
      sidewayMaxLot: 0.3,
      trendFixedTpEnabled: true,
      trendFixedTpDistance: 8,
      sidewayFixedTpEnabled: true,
      sidewayFixedTpDistance: 6.5,
    }),
    {
      trendFixedLot: 0.12,
      sidewayRiskPercent: 0.4,
      sidewayMaxLot: 0.3,
      trendFixedTpEnabled: true,
      trendFixedTpDistance: 8,
      sidewayFixedTpEnabled: true,
      sidewayFixedTpDistance: 6.5,
    },
    "RED_TARGET: validator must preserve independent Trend/Sideway Fixed TP settings.",
  );

  assert.deepEqual(
    validatePhase7CLotSettings({
      trendFixedLot: 0.03,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: 0.03,
    }),
    {
      trendFixedLot: 0.03,
      sidewayRiskPercent: 0.25,
      sidewayMaxLot: 0.03,
      trendFixedTpEnabled: false,
      trendFixedTpDistance: 0,
      sidewayFixedTpEnabled: false,
      sidewayFixedTpDistance: 0,
    },
    "legacy callers must canonicalize to Fixed TP disabled rather than break",
  );

  for (const distance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validatePhase7CLotSettings({
        trendFixedLot: 0.03,
        sidewayRiskPercent: 0.25,
        sidewayMaxLot: 0.03,
        trendFixedTpEnabled: true,
        trendFixedTpDistance: distance,
        sidewayFixedTpEnabled: false,
        sidewayFixedTpDistance: 0,
      }),
      /Trend fixed TP distance.*positive|Fixed TP.*positive/i,
      "enabled Trend Fixed TP must reject non-positive/non-finite distance",
    );
  }
});

test("pure Fixed TP contract uses executable close-side quotes", async () => {
  const {
    buildFixedTpSnapshot,
    fixedTpCommandId,
    fixedTpTargetPrice,
    isFixedTpTriggered,
  } = await loadFixedTpModule();

  assert.equal(fixedTpTargetPrice("BUY", 4700, 8), 4708);
  assert.equal(fixedTpTargetPrice("SELL", 4700, 8), 4692);

  assert.equal(isFixedTpTriggered({ side: "BUY", targetPrice: 4708, bid: 4708, ask: 4708.5 }), true);
  assert.equal(isFixedTpTriggered({ side: "BUY", targetPrice: 4708, bid: 4707.99, ask: 4708.5 }), false,
    "BUY must use bid, not ask");
  assert.equal(isFixedTpTriggered({ side: "SELL", targetPrice: 4692, bid: 4691.5, ask: 4692 }), true);
  assert.equal(isFixedTpTriggered({ side: "SELL", targetPrice: 4692, bid: 4691.5, ask: 4692.01 }), false,
    "SELL must use ask, not bid");

  assert.deepEqual(buildFixedTpSnapshot({ enabled: false, distance: 0, side: "BUY", entry: 4700 }), {
    enabled: false,
    distance: 0,
    targetPrice: null,
  });
  assert.equal(
    isFixedTpTriggered({ side: "BUY", targetPrice: null, bid: 9999, ask: 10000, enabled: false }),
    false,
    "disabled Fixed TP must be a no-op",
  );

  assert.equal(fixedTpCommandId("TREND", "304512647"), "phase7c-fixed-tp-trend-304512647");
  assert.equal(fixedTpCommandId("TREND", "304512647"), fixedTpCommandId("TREND", "304512647"),
    "Fixed TP command id must be deterministic across retries");
  assert.equal(fixedTpCommandId("SIDEWAY", "304512647"), "phase7c-fixed-tp-sideway-304512647");
});
