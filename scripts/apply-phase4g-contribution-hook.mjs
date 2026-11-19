import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase4g-contribution-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase4g.bak`;
let content = fs.readFileSync(file, "utf8");

const blockMarker = "const phase4ContributionService = new Phase4ContributionDiagnosticsService();";
if (content.includes(blockMarker)) {
  console.log(`Phase 4G contribution hook already present: ${file}`);
  console.log("PHASE4G_HOOK_STATUS=PASS");
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

if (!content.includes("Phase4ContributionDiagnosticsService")) {
  const importRegex = /(\s+Phase4ShadowDiagnosticsService,\r?\n)(\s+RiskPipeline,)/;
  if (!importRegex.test(content)) {
    throw new Error("Phase 4F import marker not found. Apply Phase 4F hook first.");
  }
  content = content.replace(
    importRegex,
    `$1  Phase4ContributionDiagnosticsService,\n$2`,
  );
}

if (!content.includes("const phase4DiagnosticsCases = phase4Research.shadowCases();")) {
  throw new Error("Phase 4F diagnostics block not found. Apply Phase 4F hook first.");
}

const phase4cMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
if (!content.includes(phase4cMarker)) {
  throw new Error("Phase 4C marker not found after Phase 4F block.");
}

const block = `const phase4ContributionService = new Phase4ContributionDiagnosticsService();\nconst phase4ContributionResult = phase4ContributionService.run(phase4DiagnosticsCases);\n\nfor (const line of phase4ContributionService.format(phase4ContributionResult)) {\n  console.log(line);\n}\n\n${phase4cMarker}`;

content = content.replace(phase4cMarker, block);
fs.writeFileSync(file, content, "utf8");

const verify = fs.readFileSync(file, "utf8");
const checks = [
  verify.includes("Phase4ContributionDiagnosticsService"),
  verify.includes(blockMarker),
  verify.includes("const phase4ContributionResult = phase4ContributionService.run(phase4DiagnosticsCases);"),
  verify.includes("phase4ContributionService.format(phase4ContributionResult)"),
];
if (!checks.every(Boolean)) {
  throw new Error("Phase 4G hook verification failed after write.");
}

console.log(`Phase 4G contribution hook applied: ${file}`);
console.log("Research-only: no production mutation.");
console.log("PHASE4G_HOOK_STATUS=PASS");
