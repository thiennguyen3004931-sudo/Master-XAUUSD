import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PHASE7C_LOT_LIMITS,
  validatePhase7CLotSettings,
} from "../apps/api/dist/services/phase7c-lot-settings.service.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDir, "..");

function source(relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("Trend and Sideway lot controls accept 0.03 through 1.20 only in 0.03 increments", () => {
  assert.equal(PHASE7C_LOT_LIMITS.minManagedLot, 0.03);
  assert.equal(PHASE7C_LOT_LIMITS.maxDemoLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxManagedLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxTrendLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.maxSidewayLot, 1.2);
  assert.equal(PHASE7C_LOT_LIMITS.managedLotIncrement, 0.03);

  for (const lot of [0.03, 0.06, 0.3, 0.6, 1.17, 1.2]) {
    assert.deepEqual(
      validatePhase7CLotSettings({
        trendFixedLot: lot,
        sidewayRiskPercent: 1,
        sidewayMaxLot: lot,
      }),
      {
        trendFixedLot: lot,
        sidewayRiskPercent: 1,
        sidewayMaxLot: lot,
        trendFixedTpEnabled: false,
        trendFixedTpDistance: 0,
        sidewayFixedTpEnabled: false,
        sidewayFixedTpDistance: 0,
      },
      `lot ${lot} must be accepted for both Trend and Sideway with additive Fixed TP defaulting OFF`,
    );
  }

  for (const lot of [0.01, 0.04, 0.05, 1.21, 1.23]) {
    assert.throws(
      () => validatePhase7CLotSettings({
        trendFixedLot: lot,
        sidewayRiskPercent: 1,
        sidewayMaxLot: 0.03,
      }),
      /0\.03.*1\.20|1\.20.*0\.03|0\.03 increments/i,
      `Trend lot ${lot} must fail the 0.03..1.20 step-0.03 contract`,
    );
    assert.throws(
      () => validatePhase7CLotSettings({
        trendFixedLot: 0.03,
        sidewayRiskPercent: 1,
        sidewayMaxLot: lot,
      }),
      /0\.03.*1\.20|1\.20.*0\.03|0\.03 increments/i,
      `Sideway lot ${lot} must fail the 0.03..1.20 step-0.03 contract`,
    );
  }

  assert.throws(
    () => validatePhase7CLotSettings({
      trendFixedLot: 0.03,
      sidewayRiskPercent: 1.01,
      sidewayMaxLot: 0.03,
    }),
    /1(?:\.00)?%|risk percent|0\.01.*1/i,
    "Sideway risk percent must remain capped at 1.00%",
  );
});

test("all execution boundaries use the same 1.20 ceiling and 0.03 lot increment", () => {
  const supervisor = source("scripts/run-phase7c-executors-local.ps1");
  const trendLauncher = source("scripts/run-phase7c-trend-controller-local.ps1");
  const sidewayLauncher = source("scripts/run-phase7c-sideway-controller-local.ps1");
  const accountModeLibrary = source("scripts/lib/phase7c-account-mode.ps1");
  const activation = source("scripts/activate-phase7c-local.ps1");
  const trendController = source("scripts/run-phase7b-demo-controller.ts");
  const sidewayController = source("scripts/run-phase7c-sideway-controller.mjs");

  assert.match(supervisor, /\$TrendFixedVolume\s+-gt\s+1\.2/);
  assert.match(supervisor, /\$SidewayMaxLot\s+-gt\s+1\.2/);
  assert.match(supervisor, /\$TrendFixedVolume\s*\/\s*0\.03/);
  assert.match(supervisor, /\$SidewayMaxLot\s*\/\s*0\.03/);

  assert.match(trendLauncher, /\$FixedVolume\s+-gt\s+1\.2/);
  assert.match(trendLauncher, /\$FixedVolume\s*\/\s*0\.03/);
  assert.match(sidewayLauncher, /\$MaxLot\s+-gt\s+1\.2/);
  assert.match(sidewayLauncher, /\$MaxLot\s*\/\s*0\.03/);

  assert.match(accountModeLibrary, /\$trend\s+-gt\s+1\.20/);
  assert.match(accountModeLibrary, /\$maxLot\s+-gt\s+1\.20/);
  assert.match(accountModeLibrary, /\$trend\s*\/\s*0\.03/);
  assert.match(accountModeLibrary, /\$maxLot\s*\/\s*0\.03/);

  assert.match(activation, /\$TrendFixedVolume\s+-gt\s+1\.2/);
  assert.match(activation, /\$SidewayMaxLot\s+-gt\s+1\.2/);
  assert.match(activation, /\$TrendFixedVolume\s*\/\s*0\.03/);
  assert.match(activation, /\$SidewayMaxLot\s*\/\s*0\.03/);

  assert.match(trendController, /MAX_TREND_FIXED_VOLUME\s*=\s*1\.2/);
  assert.match(sidewayController, /MAX_SIDEWAY_LOT\s*=\s*1\.2/);
  assert.match(sidewayController, /rawMaxLot\s*\/\s*0\.03/);
});

test("API broker validation and canonical Account & Risk Web lot controls preserve the 1.20 step-0.03 contract", () => {
  const route = source("apps/api/src/routes/phase7c.route.ts");
  const accountRisk = source("apps/web/src/pages/Phase7BOpsPage.tsx");

  assert.match(
    route,
    /Trend fixed lot[^\n]*exact one-third partial close/s,
    "Trend broker validation must preserve exact one-third compatibility",
  );
  assert.match(
    route,
    /Sideway max lot[^\n]*exact one-third partial close/s,
    "Sideway max lot must use the same 0.03 one-third-compatible increment",
  );

  assert.match(accountRisk, /const\s+MANAGED_LOT_STEP\s*=\s*0\.03/,
    "Account & Risk must keep the canonical managed lot step at 0.03");
  assert.match(
    accountRisk,
    /label="Trend fixed lot"[\s\S]*?min:\s*0\.03,\s*max:\s*1\.2,\s*step:\s*MANAGED_LOT_STEP/,
    "Account & Risk Trend fixed lot must expose max 1.20 with step 0.03",
  );
  assert.match(
    accountRisk,
    /label="Sideway risk percent"[\s\S]*?min:\s*0\.01,\s*max:\s*1,\s*step:\s*0\.01/,
    "Account & Risk Sideway risk percent must expose 0.01..1.00% with step 0.01",
  );
  assert.match(
    accountRisk,
    /label="Sideway max lot"[\s\S]*?min:\s*0\.03,\s*max:\s*1\.2,\s*step:\s*MANAGED_LOT_STEP/,
    "Account & Risk Sideway max lot must expose max 1.20 with step 0.03",
  );

  assert.match(accountRisk, /Trend fixed lot phải trong khoảng 0\.03–1\.20\./);
  assert.match(accountRisk, /Sideway max lot phải trong khoảng 0\.03–1\.20\./);
  assert.match(accountRisk, /Sideway risk percent phải trong khoảng 0\.01–1\.00%\./);
  assert.doesNotMatch(accountRisk, /0\.03–0\.30/);
});
