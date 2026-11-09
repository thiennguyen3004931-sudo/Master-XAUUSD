import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase4d-sweep-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase4d.bak`;
let content = fs.readFileSync(file, "utf8");

if (content.includes("PHASE4D_VARIANTS=")) {
  console.log(`Phase 4D hook already present: ${file}`);
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

const importMarker = `  Phase4ShadowReplayService,\n  RiskPipeline,`;
const importReplacement = `  Phase4ShadowReplayService,\n  Phase4ManagementSweepService,\n  RiskPipeline,`;
if (!content.includes(importMarker)) {
  throw new Error("Phase 4C import marker not found. Apply Phase 4C hook first.");
}
content = content.replace(importMarker, importReplacement);

const logMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
const sweepBlock = `const phase4SweepService = new Phase4ManagementSweepService();\nconst phase4SweepResult = phase4SweepService.run(phase4Research.shadowCases());\n\nfor (const line of phase4SweepService.format(phase4SweepResult)) {\n  console.log(line);\n}\n\n${logMarker}`;
if (!content.includes(logMarker)) {
  throw new Error("Phase 4C log marker not found.");
}
content = content.replace(logMarker, sweepBlock);

fs.writeFileSync(file, content, "utf8");
console.log(`Phase 4D management sweep hook applied: ${file}`);
console.log("Research-only: entries, risk cap, canonical SL/TP, and production execution remain unchanged.");
