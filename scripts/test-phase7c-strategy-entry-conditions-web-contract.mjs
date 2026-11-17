import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cardPath = path.join(root, "apps/web/src/ui/Phase7CStrategyEntryConditionsCard.tsx");
const pagePath = path.join(root, "apps/web/src/pages/Phase7CAccountRiskPage.tsx");

assert.ok(
  fs.existsSync(cardPath),
  "RED_TARGET_COMPONENT: Web Control Center must provide a dedicated strategy entry conditions card",
);

const card = fs.readFileSync(cardPath, "utf8");
const page = fs.readFileSync(pagePath, "utf8");

assert.match(card, /\/api\/v1\/phase7c\/strategy-entry-conditions/);
assert.match(card, /\/api\/v1\/phase7c\/decision-monitor/);
assert.match(card, /expectedVersion:\s*state\.version/);
assert.match(card, /source:\s*["']web-control-center["']/);
assert.match(card, /trend:\s*draft\.trend/);
assert.match(card, /sideway:\s*draft\.sideway/);

for (const id of [
  "patternM15",
  "supertrendM15",
  "supertrendM5",
  "validTrendStructure",
  "ma20Ma50",
  "fvg",
  "rangingRegime",
  "recommendedModeSideway",
  "minimumRegimeConfidence",
  "supplyDemandRange",
  "rangeEdge",
  "m5Confirmation",
]) {
  assert.match(card, new RegExp(`\\b${id}\\b`), `Condition ${id} must be represented by the Web UI`);
}

assert.match(card, /MANDATORY_TREND\s*=\s*new Set\([^)]*["']patternM15["']/s);
assert.match(card, /MANDATORY_SIDEWAY\s*=\s*new Set\([^)]*["']rangeEdge["']/s);
assert.match(card, /disabled=\{[^}]*mandatory[^}]*\|\|[^}]*!editable/s);
assert.match(card, /PASS/);
assert.match(card, /FAIL/);
assert.match(card, /IGNORED/);
assert.match(card, /strategyEntryConditions/);
assert.match(card, /editable/);
assert.match(card, /guards/);
assert.match(card, /NEW_ENTRIES_ONLY/);
assert.match(card, /CONFIG_VERSION_CONFLICT/);

assert.doesNotMatch(card, /\/api\/v1\/phase7c\/bot-mode[^"']*["']/);
assert.doesNotMatch(card, /\/api\/v1\/phase7c\/lifecycle\/(?:start|stop)/);
assert.doesNotMatch(card, /\/v1\/orders/);
assert.doesNotMatch(card, /ARM|arm-live|live-arm/i);

assert.match(page, /Phase7CStrategyEntryConditionsCard/);
assert.match(page, /<Phase7CStrategyEntryConditionsCard\s*\/\s*>/);

console.log("PHASE7C_STRATEGY_ENTRY_WEB_CONTRACT=PASS");
