import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const required = [
  "apps/api/src/contracts/phase7c-recommendation-intelligence.schema.ts",
  "apps/api/src/services/phase7c-recommendation-evaluator.service.ts",
  "apps/api/src/services/phase7c-recommendation-intelligence.service.ts",
  "apps/api/src/routes/phase7c-recommendation-intelligence.route.ts",
  "apps/web/src/phase7c-recommendation-intelligence-types.ts",
  "apps/web/src/phase7c-recommendation-intelligence-api.ts",
  "apps/web/src/ui/Phase7CRecommendationIntelligenceCard.tsx",
];

for (const file of required) {
  assert.equal(exists(file), true, `missing ${file}`);
}

const schema = read(required[0]);
for (const literal of [
  "phase7c-recommendation-intelligence-v1",
  '"KEEP_CURRENT"',
  '"REVIEW_CHANGE"',
  '"COLLECT_MORE_EVIDENCE"',
  '"UNAVAILABLE"',
  '"HIGH"',
  '"MEDIUM"',
  '"LOW"',
  '"NONE"',
  "autoApply: false",
  "autoRetune: false",
  "advisoryOnly: true",
  "evidenceScoreIsNotProbability: true",
]) {
  assert.ok(schema.includes(literal), `schema missing literal: ${literal}`);
}

const evaluator = read(required[1]);
for (const literal of [
  "MIN_SAMPLE_FOR_REVIEW = 10",
  "MIN_SAMPLE_FOR_HIGH_CONFIDENCE = 30",
  "EXACT_LINEAGE_REQUIRED",
  "BOUNDED_DIRECTIONAL_EVIDENCE",
  "MISSING_COMPARABLE_DELTA",
]) {
  assert.ok(evaluator.includes(literal), `evaluator missing literal: ${literal}`);
}

const service = read(required[2]);
assert.ok(
  service.includes("buildPhase7CCounterfactualSnapshotFromRows"),
  "P5 must derive P4 from the same canonical P3 rows to avoid cross-snapshot drift",
);
assert.equal(
  service.includes("getPhase7CCounterfactualIntelligence("),
  false,
  "P5 must not independently reread P4/P3 while composing one recommendation snapshot",
);

const card = read(required[6]);
for (const literal of [
  "P5 · Recommendation Intelligence",
  "READ ONLY",
  "ADVISORY ONLY",
  "AUTO APPLY: DISABLED",
  "AUTO RETUNE: DISABLED",
  "Không cập nhật được dữ liệu P5 mới; đang hiển thị snapshot gần nhất.",
]) {
  assert.ok(card.includes(literal), `P5 card missing literal: ${literal}`);
}

for (const forbidden of [
  "Accept & Apply",
  "Apply recommendation",
  "Retune now",
  "saveRecommendation",
  "applyRecommendation",
  "retuneRecommendation",
]) {
  assert.equal(card.includes(forbidden), false, `forbidden P5 UI mutation surface: ${forbidden}`);
}

const shell = read("apps/web/src/pages/Phase7CControlCenterShellPage.tsx");
assert.ok(shell.includes("Phase7CRecommendationIntelligenceCard"), "P5 card is not mounted in Control Center shell");
const p4Index = shell.indexOf("<Phase7CCounterfactualIntelligenceCard />");
const p5Index = shell.indexOf("<Phase7CRecommendationIntelligenceCard />");
const p1Index = shell.indexOf("<Phase7CRuntimeSourceAttestationCard />");
assert.ok(p4Index >= 0 && p5Index > p4Index && p1Index > p5Index, "P5 card must render after P4 and before runtime-source attestation");

console.log("PHASE7C_RECOMMENDATION_INTELLIGENCE_SOURCE_CONTRACT=PASS");
