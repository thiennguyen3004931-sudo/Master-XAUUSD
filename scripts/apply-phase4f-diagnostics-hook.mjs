import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase4f-diagnostics-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase4f.bak`;
let content = fs.readFileSync(file, "utf8");

const blockMarker = "const phase4DiagnosticsService = new Phase4ShadowDiagnosticsService();";
if (content.includes(blockMarker)) {
  console.log(`Phase 4F diagnostics hook already present: ${file}`);
  console.log("PHASE4F_HOOK_STATUS=PASS");
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

if (!content.includes("Phase4ShadowDiagnosticsService")) {
  const importRegex = /(\s+Phase4WalkForwardService,\r?\n)(\s+RiskPipeline,)/;
  if (!importRegex.test(content)) {
    throw new Error("Phase 4E import marker not found. Apply Phase 4E hook first.");
  }
  content = content.replace(
    importRegex,
    `$1  Phase4ShadowDiagnosticsService,\n$2`,
  );
}

if (!content.includes("const phase4WalkForwardService = new Phase4WalkForwardService();")) {
  throw new Error("Phase 4E walk-forward block not found. Apply Phase 4E hook first.");
}

// Phase4WalkForwardService.format() already emits this invariant. Remove the
// old explicit duplicate inserted by the first Phase 4E hook revision.
content = content.replace(
  /\r?\nconsole\.log\(["']PHASE4E_PRODUCTION_MUTATION=false["']\);\r?\n/,
  "\n",
);

const phase4cMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
if (!content.includes(phase4cMarker)) {
  throw new Error("Phase 4C marker not found after Phase 4E block.");
}

const block = `const phase4DiagnosticsCases = phase4Research.shadowCases();\nconst phase4DiagnosticsService = new Phase4ShadowDiagnosticsService();\nconst phase4DiagnosticsResult = phase4DiagnosticsService.run(phase4DiagnosticsCases);\n\nfor (const line of phase4DiagnosticsService.format(phase4DiagnosticsResult)) {\n  console.log(line);\n}\n\nconst phase4DiagnosticsResearchResult = phase4Research.result();\nconsole.log(\`PHASE4F_PHASE4_TOTAL_CASES=\${phase4DiagnosticsResearchResult.counters.totalCases}\`);\nconsole.log(\`PHASE4F_PHASE4_FINAL_MINLOT_FEASIBLE=\${phase4DiagnosticsResearchResult.counters.finalMinLotFeasible}\`);\nconsole.log(\`PHASE4F_SHADOW_DELTA=\${phase4DiagnosticsCases.length - phase4DiagnosticsResearchResult.counters.finalMinLotFeasible}\`);\n\n${phase4cMarker}`;

content = content.replace(phase4cMarker, block);
fs.writeFileSync(file, content, "utf8");

const verify = fs.readFileSync(file, "utf8");
const checks = [
  verify.includes("Phase4ShadowDiagnosticsService"),
  verify.includes(blockMarker),
  verify.includes("PHASE4F_PHASE4_FINAL_MINLOT_FEASIBLE="),
  verify.includes("PHASE4F_SHADOW_DELTA="),
];
if (!checks.every(Boolean)) {
  throw new Error("Phase 4F hook verification failed after write.");
}

console.log(`Phase 4F diagnostics hook applied: ${file}`);
console.log("Research-only: no production mutation and no forced deduplication.");
console.log("PHASE4F_HOOK_STATUS=PASS");
