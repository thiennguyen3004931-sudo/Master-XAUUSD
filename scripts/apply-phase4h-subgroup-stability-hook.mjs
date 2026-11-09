import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase4h-subgroup-stability-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase4h.bak`;
let content = fs.readFileSync(file, "utf8");

const blockMarker = "const phase4SubgroupStabilityService = new Phase4SubgroupStabilityService();";
if (content.includes(blockMarker)) {
  console.log(`Phase 4H subgroup stability hook already present: ${file}`);
  console.log("PHASE4H_HOOK_STATUS=PASS");
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

if (!content.includes("Phase4SubgroupStabilityService")) {
  const importRegex = /(\s+Phase4ContributionDiagnosticsService,\r?\n)(\s+RiskPipeline,)/;
  if (!importRegex.test(content)) {
    throw new Error("Phase 4G import marker not found. Apply Phase 4G hook first.");
  }
  content = content.replace(
    importRegex,
    `$1  Phase4SubgroupStabilityService,\n$2`,
  );
}

if (!content.includes("const phase4ContributionService = new Phase4ContributionDiagnosticsService();")) {
  throw new Error("Phase 4G contribution block not found. Apply Phase 4G hook first.");
}
if (!content.includes("const phase4DiagnosticsCases = phase4Research.shadowCases();")) {
  throw new Error("Phase 4F diagnostics cases not found.");
}

const phase4cMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
if (!content.includes(phase4cMarker)) {
  throw new Error("Phase 4C marker not found after Phase 4G block.");
}

const block = `const phase4SubgroupStabilityService = new Phase4SubgroupStabilityService();\nconst phase4SubgroupStabilityResult = phase4SubgroupStabilityService.run(phase4DiagnosticsCases);\n\nfor (const line of phase4SubgroupStabilityService.format(phase4SubgroupStabilityResult)) {\n  console.log(line);\n}\n\n${phase4cMarker}`;

content = content.replace(phase4cMarker, block);
fs.writeFileSync(file, content, "utf8");

const verify = fs.readFileSync(file, "utf8");
const checks = [
  verify.includes("Phase4SubgroupStabilityService"),
  verify.includes(blockMarker),
  verify.includes("const phase4SubgroupStabilityResult = phase4SubgroupStabilityService.run(phase4DiagnosticsCases);"),
  verify.includes("phase4SubgroupStabilityService.format(phase4SubgroupStabilityResult)"),
];
if (!checks.every(Boolean)) {
  throw new Error("Phase 4H hook verification failed after write.");
}

console.log(`Phase 4H subgroup stability hook applied: ${file}`);
console.log("Research-only: no subgroup filter is promoted to production.");
console.log("PHASE4H_HOOK_STATUS=PASS");
