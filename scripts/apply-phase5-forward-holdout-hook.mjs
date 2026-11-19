import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase5-forward-holdout-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase5.bak`;
let content = fs.readFileSync(file, "utf8");

const blockMarker = "const phase5ForwardHoldoutService = new Phase5ForwardHoldoutService();";
if (content.includes(blockMarker)) {
  console.log(`Phase 5 forward holdout hook already present: ${file}`);
  console.log("PHASE5_HOOK_STATUS=PASS");
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

if (!content.includes("Phase5ForwardHoldoutService")) {
  const importRegex = /(\s+Phase4SubgroupStabilityService,\r?\n)(\s+RiskPipeline,)/;
  if (!importRegex.test(content)) {
    throw new Error("Phase 4H import marker not found. Apply Phase 4H hook first.");
  }
  content = content.replace(
    importRegex,
    `$1  Phase5ForwardHoldoutService,\n$2`,
  );
}

if (!content.includes("const phase4SubgroupStabilityService = new Phase4SubgroupStabilityService();")) {
  throw new Error("Phase 4H subgroup stability block not found. Apply Phase 4H hook first.");
}
if (!content.includes("const phase4DiagnosticsCases = phase4Research.shadowCases();")) {
  throw new Error("Phase 4F diagnostics cases not found.");
}

const phase4cMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
if (!content.includes(phase4cMarker)) {
  throw new Error("Phase 4C marker not found after Phase 4H block.");
}

const block = `const phase5ForwardHoldoutService = new Phase5ForwardHoldoutService();\nconst phase5ForwardHoldoutResult = phase5ForwardHoldoutService.run(phase4DiagnosticsCases);\n\nfor (const line of phase5ForwardHoldoutService.format(phase5ForwardHoldoutResult)) {\n  console.log(line);\n}\n\n${phase4cMarker}`;

content = content.replace(phase4cMarker, block);
fs.writeFileSync(file, content, "utf8");

const verify = fs.readFileSync(file, "utf8");
const checks = [
  verify.includes("Phase5ForwardHoldoutService"),
  verify.includes(blockMarker),
  verify.includes("const phase5ForwardHoldoutResult = phase5ForwardHoldoutService.run(phase4DiagnosticsCases);"),
  verify.includes("phase5ForwardHoldoutService.format(phase5ForwardHoldoutResult)"),
];
if (!checks.every(Boolean)) {
  throw new Error("Phase 5 forward holdout hook verification failed after write.");
}

console.log(`Phase 5 forward holdout hook applied: ${file}`);
console.log("Pre-registered CANONICAL_SELL validation only; production remains unchanged.");
console.log("PHASE5_HOOK_STATUS=PASS");
