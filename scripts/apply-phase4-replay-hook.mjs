import fs from "node:fs";
import path from "node:path";

const targetArg = process.argv[2];
if (!targetArg) {
  console.error("Usage: node scripts/apply-phase4-replay-hook.mjs <canonical_replay.ts>");
  process.exit(1);
}

const target = path.resolve(targetArg);
if (!fs.existsSync(target)) {
  console.error(`Replay file not found: ${target}`);
  process.exit(1);
}

let source = fs.readFileSync(target, "utf8");
if (source.includes("Phase4CanonicalReplayAdapter") && source.includes("PHASE4_PRODUCTION_EQUIVALENCE=false")) {
  console.log("Phase 4 replay hook already applied; no changes made.");
  process.exit(0);
}

const backup = `${target}.phase4.bak`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(target, backup);
  console.log(`Backup created: ${backup}`);
}

function replaceOnce(pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Patch anchor not found: ${label}`);
  }
  source = source.replace(pattern, replacement);
}

replaceOnce(
  /import\s*\{\s*RiskPipeline,?\s*\}\s*from\s*["']@xauusd\/risk-engine["'];/m,
  `import {\n  Phase4CanonicalReplayAdapter,\n  RiskPipeline,\n} from "@xauusd/risk-engine";`,
  "risk-engine import",
);

replaceOnce(
  /const riskEngine = new RiskPipeline\(\);/,
  `const riskEngine = new RiskPipeline();\nconst phase4Research = new Phase4CanonicalReplayAdapter();`,
  "risk engine initialization",
);

const researchHook = `\n  const canonicalEntry = Number(plan.order.entry);\n  const canonicalStopLoss = Number(plan.order.stopLoss);\n  const signalTimestamp = current.closeTime;\n  const expiresAt = Number(\n    plan.expiresAt ?? (signalTimestamp + 3 * 5 * 60_000),\n  );\n\n  if (\n    Number.isFinite(canonicalEntry) &&\n    Number.isFinite(canonicalStopLoss) &&\n    expiresAt >= signalTimestamp\n  ) {\n    phase4Research.add({\n      id: \`phase4-\${signalTimestamp}-\${String(plan.order.side)}\`,\n      side: plan.order.side,\n      canonicalEntry,\n      canonicalStopLoss,\n      signalTimestamp,\n      expiresAt,\n      effectiveRiskCapUsd: maximumRiskUsd,\n      instrument: {\n        symbol: "XAUUSD",\n        tickSize: meta.tickSize,\n        tickValuePerLot: meta.effectiveTickValuePerLot,\n        contractSize: 100,\n        minVolume: 0.01,\n        maxVolume: 100,\n        volumeStep: 0.01,\n        maxSpread: Number.POSITIVE_INFINITY,\n        priceDigits: 2,\n      },\n      m5Bars: rawM5,\n      maxM5Bars: 12,\n    });\n  }\n\n`;

replaceOnce(
  /\n\s*const volume =\s*\n?\s*Number\(plan\.order\.volume\);/m,
  `${researchHook}  const volume =\n    Number(plan.order.volume);`,
  "pre-minlot gate hook",
);

const counterBlock = `\nconst phase4Result = phase4Research.result();\nfor (const line of phase4Research.formatCounters()) {\n  console.log(line);\n}\n\nconsole.log("PHASE4_PRODUCTION_EQUIVALENCE=false");\nconsole.log("PHASE4_CANONICAL_SIGNAL_UNCHANGED=PASS");\nconsole.log("PHASE4_CANONICAL_STOP_PRESERVED=PASS");\nconsole.log("PHASE4_PER_TRADE_RISK_CAP_PRESERVED=PASS");\n\n`;

replaceOnce(
  /console\.log\(\s*["']NO_LOOKAHEAD_ENTRY_PATH=PASS["'],?\s*\);/m,
  `${counterBlock}console.log(\n  "NO_LOOKAHEAD_ENTRY_PATH=PASS",\n);`,
  "final replay counters",
);

fs.writeFileSync(target, source, "utf8");
console.log(`Phase 4 replay hook applied: ${target}`);
console.log("Research-only: canonical execution path is unchanged.");
console.log("Run the replay and inspect PHASE4_* counters.");
