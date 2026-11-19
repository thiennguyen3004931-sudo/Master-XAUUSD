import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  assert.equal(fs.existsSync(path), true, `Missing required P4 source file: ${path}`);
  return fs.readFileSync(path, "utf8");
}

const schema = read("apps/api/src/contracts/phase7c-counterfactual-intelligence.schema.ts");
const evaluator = read("apps/api/src/services/phase7c-counterfactual-evaluator.service.ts");
const service = read("apps/api/src/services/phase7c-counterfactual-intelligence.service.ts");
const route = read("apps/api/src/routes/phase7c-counterfactual-intelligence.route.ts");
const types = read("apps/web/src/phase7c-counterfactual-intelligence-types.ts");
const api = read("apps/web/src/phase7c-counterfactual-intelligence-api.ts");
const card = read("apps/web/src/ui/Phase7CCounterfactualIntelligenceCard.tsx");
const shell = read("apps/web/src/pages/Phase7CControlCenterShellPage.tsx");

assert.match(schema, /phase7c-counterfactual-intelligence-v1/);
assert.match(schema, /"EXACT" \| "BOUNDED" \| "UNAVAILABLE"/);
assert.match(schema, /"FAST_MOVE_GIVEBACK"/);
assert.match(schema, /"RULE_OBSERVATION"/);
assert.match(schema, /"MANAGEMENT_EXIT_POLICY"/);
assert.match(schema, /readOnly:\s*true/);
assert.match(schema, /shadowOnly:\s*true/);
assert.match(schema, /autoApply:\s*false/);
assert.match(schema, /autoRetune:\s*false/);

assert.match(evaluator, /CURRENT_ACTIVATION_PRICE\s*=\s*10/);
assert.match(evaluator, /CURRENT_GIVEBACK_PRICE\s*=\s*10/);
assert.match(evaluator, /ORDERED_EXIT_SIDE_PRICES/);
assert.match(evaluator, /COUNTERFACTUAL_EXIT_NOT_PROVABLE/);
assert.match(evaluator, /COUNTERFACTUAL_PNL_NOT_PROVABLE/);
assert.doesNotMatch(evaluator, /fetch\s*\(/);

assert.match(service, /FAST_MOVE_SHADOW_GIVEBACK_GRID\s*=\s*\[4, 6, 8, 12\]/);
assert.match(service, /M5 OHLC is not treated as ordered intrabar evidence/);
assert.match(service, /not a recommendation/);
assert.match(service, /row\.strategy === "REVERSAL" \? "TREND" : row\.strategy/);
assert.doesNotMatch(service, /autoRetune:\s*true/);

assert.match(route, /router\.get\("\/"/);
assert.doesNotMatch(route, /router\.(post|put|patch|delete)\s*\(/i);

assert.match(types, /phase7c-counterfactual-intelligence-v1/);
assert.match(types, /"REVERSAL"/);
assert.match(types, /readOnly:\s*true/);
assert.match(types, /shadowOnly:\s*true/);
assert.match(types, /autoApply:\s*false/);
assert.match(types, /autoRetune:\s*false/);

assert.match(api, /method:\s*"GET"/);
assert.match(api, /cache:\s*"no-store"/);
assert.match(api, /\/api\/v1\/phase7c\/counterfactual-intelligence/);
assert.doesNotMatch(api, /method:\s*"(POST|PUT|PATCH|DELETE)"/);

assert.match(card, /useState\(false\)/);
assert.match(card, /P4 · Shadow \/ Counterfactual Intelligence/);
assert.match(card, /READ ONLY/);
assert.match(card, /SHADOW ONLY/);
assert.match(card, /AUTO RETUNE: DISABLED/);
assert.match(card, /EXACT/);
assert.match(card, /BOUNDED/);
assert.match(card, /UNAVAILABLE/);
assert.match(card, /Hiện chi tiết/);
assert.match(card, /Ẩn chi tiết/);
assert.doesNotMatch(card, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
assert.doesNotMatch(card, /Lưu cấu hình|Áp dụng thay đổi|Apply recommendation/i);

assert.match(shell, /Phase7CCounterfactualIntelligenceCard/);
const p3Index = shell.indexOf("<Phase7CPerformanceEffectivenessCard");
const p4Index = shell.indexOf("<Phase7CCounterfactualIntelligenceCard");
const attestationIndex = shell.indexOf("<Phase7CRuntimeSourceAttestationCard");
assert.ok(p3Index >= 0, "P3 card mount missing");
assert.ok(p4Index > p3Index, "P4 card must render after P3");
assert.ok(attestationIndex > p4Index, "runtime source attestation must remain after P4");

console.log("P4_COUNTERFACTUAL_SOURCE_TEST=PASS");
console.log("P4_UI_DEFAULT_VIEW=COLLAPSED");
console.log("P4_UI_AUTO_RETUNE=DISABLED");
console.log("P4_UI_MUTATION=NONE");
