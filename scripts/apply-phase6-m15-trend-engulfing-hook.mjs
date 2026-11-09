import fs from "node:fs";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/apply-phase6-m15-trend-engulfing-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const file = path.resolve(target);
const backup = `${file}.phase6.bak`;
let content = fs.readFileSync(file, "utf8");

const blockMarker = "const phase6M15TrendEngulfingService = new Phase6M15TrendEngulfingService();";
if (content.includes(blockMarker)) {
  console.log(`Phase 6 M15 trend-engulfing hook already present: ${file}`);
  console.log("PHASE6_HOOK_STATUS=PASS");
  process.exit(0);
}

if (!fs.existsSync(backup)) {
  fs.copyFileSync(file, backup);
  console.log(`Backup created: ${backup}`);
}

if (!content.includes("Phase6M15TrendEngulfingService")) {
  const importRegex = /(\s+Phase5ForwardHoldoutService,\r?\n)(\s+RiskPipeline,)/;
  if (!importRegex.test(content)) {
    throw new Error("Phase 5 import marker not found. Apply the Phase 5 hook first.");
  }
  content = content.replace(
    importRegex,
    `$1  Phase6M15TrendEngulfingService,\n$2`,
  );
}

for (const marker of ["rawM15", "rawM5", "maximumRiskUsd", "meta.effectiveTickValuePerLot"]) {
  if (!content.includes(marker)) {
    throw new Error(`Required replay marker not found for Phase 6: ${marker}`);
  }
}

const finalMarker = `console.log("PHASE4C_RESEARCH_ONLY=PASS");`;
if (!content.includes(finalMarker)) {
  throw new Error("Phase 4C final marker not found; cannot place Phase 6 research block safely.");
}

const block = `const phase6M15TrendEngulfingService = new Phase6M15TrendEngulfingService();\nconst phase6M15TrendEngulfingResult = phase6M15TrendEngulfingService.run({\n  m15Bars: rawM15,\n  m5Bars: rawM5,\n  riskCapUsd: maximumRiskUsd,\n  tickSize: meta.tickSize,\n  tickValuePerLot: meta.effectiveTickValuePerLot,\n  minVolume: 0.01,\n  volumeStep: 0.01,\n});\n\nfor (const line of phase6M15TrendEngulfingService.format(phase6M15TrendEngulfingResult)) {\n  console.log(line);\n}\n\n${finalMarker}`;

content = content.replace(finalMarker, block);
fs.writeFileSync(file, content, "utf8");

const verify = fs.readFileSync(file, "utf8");
const checks = [
  verify.includes("Phase6M15TrendEngulfingService"),
  verify.includes(blockMarker),
  verify.includes("m15Bars: rawM15"),
  verify.includes("m5Bars: rawM5"),
  verify.includes("phase6M15TrendEngulfingService.format(phase6M15TrendEngulfingResult)"),
];
if (!checks.every(Boolean)) {
  throw new Error("Phase 6 hook verification failed after write.");
}

console.log(`Phase 6 M15 trend-engulfing hook applied: ${file}`);
console.log("Research-only M15 engulfing + MA + FVG + volume-profile lane; production remains unchanged.");
console.log("PHASE6_HOOK_STATUS=PASS");
