import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const webPath = "apps/web/src/pages/Phase7CControlCenterPage.tsx";
const sidewayPath = "scripts/run-phase7c-sideway-controller.mjs";

const webSource = readFileSync(webPath, "utf8");
const sidewaySource = readFileSync(sidewayPath, "utf8");

assert.match(
  sidewaySource,
  /const\s+volume\s*=\s*Number\(autoLotValidation\.recommendedLot\);[\s\S]*?resolveDailyRecoveryPlan\([\s\S]*?freshQuote,[\s\S]*?spec,[\s\S]*?volume,[\s\S]*?\)/,
  "Sideway executor must continue computing Daily Recovery from the validated actual Auto Lot volume.",
);

const previewStart = webSource.indexOf("const recoveryPreviewVolume");
const previewEnd = webSource.indexOf("const dailyRecovery", previewStart);
assert.ok(previewStart >= 0 && previewEnd > previewStart, "Control Center recovery preview block was not found.");

const previewBlock = webSource.slice(previewStart, previewEnd);

assert.match(
  previewBlock,
  /preTrade\?\.approved\s*===\s*true|preTrade\.approved\s*===\s*true/,
  "Daily Recovery preview must only trust a setup lot when the current pre-trade decision is approved.",
);
assert.match(
  previewBlock,
  /preTrade\?\.finalLot|preTrade\.finalLot/,
  "Daily Recovery preview must consume the canonical preTrade.finalLot when an approved setup exists.",
);
assert.match(
  previewBlock,
  /Number\.isFinite|>\s*0/,
  "Daily Recovery preview must validate the canonical final lot before using it.",
);
assert.match(
  previewBlock,
  /configuredSidewayMaxLot/,
  "Sideway max lot must remain only as the no-approved-setup preview fallback.",
);
assert.match(
  previewBlock,
  /configuredTrendLot/,
  "Trend fixed lot must remain only as the no-approved-setup preview fallback.",
);

console.log("PHASE7C_DAILY_RECOVERY_PREVIEW_ACTUAL_LOT_SOURCE=PASS");
