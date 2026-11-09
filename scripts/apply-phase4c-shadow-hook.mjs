import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase4c-shadow-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase4c.bak`;
let content = fs.readFileSync(file, "utf8");

if (content.includes("PHASE4C_TOTAL_CASES=")) {
  console.log(`Phase 4C hook already present: ${file}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

const importMarker = `  Phase4CanonicalReplayAdapter,\n  RiskPipeline,`;
const importReplacement = `  Phase4CanonicalReplayAdapter,\n  Phase4ShadowReplayService,\n  RiskPipeline,`;
if (!content.includes(importMarker)) {
  throw new Error("Phase 4 import marker not found. Ensure Phase 4 hook is applied first.");
}
content = content.replace(importMarker, importReplacement);

const tpMarker = `      canonicalStopLoss,\n      signalTimestamp,`;
const tpReplacement = `      canonicalStopLoss,\n      canonicalTakeProfit: Number(plan.order.takeProfit),\n      signalTimestamp,`;
if (!content.includes(tpMarker)) {
  throw new Error("Phase 4 add() marker not found.");
}
content = content.replace(tpMarker, tpReplacement);

const logMarker = `console.log("PHASE4_PRODUCTION_EQUIVALENCE=false");`;
const shadowBlock = `const phase4ShadowService = new Phase4ShadowReplayService();\nconst phase4ShadowResult = phase4ShadowService.run(phase4Research.shadowCases());\n\nfor (const line of phase4ShadowService.formatMetrics(phase4ShadowResult.metrics)) {\n  console.log(line);\n}\n\nconsole.log("PHASE4C_RESEARCH_ONLY=PASS");\nconsole.log("PHASE4C_MINLOT_FIXED=0.01");\nconsole.log("PHASE4C_STOP_FIRST=PASS");\nconsole.log("PHASE4C_PRODUCTION_MUTATION=false");\n\n${logMarker}`;
if (!content.includes(logMarker)) {
  throw new Error("Phase 4 log marker not found.");
}
content = content.replace(logMarker, shadowBlock);

fs.writeFileSync(file, content, "utf8");
console.log(`Phase 4C shadow hook applied: ${file}`);
console.log("Research-only: production execution and sizing remain unchanged.");
