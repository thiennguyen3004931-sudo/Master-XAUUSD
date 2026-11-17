import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const targetArg = process.argv[2] ?? path.join(scriptDir, "run-phase7b-demo-controller.ts");
const target = path.resolve(targetArg);
const templatePath = path.join(scriptDir, "templates", "phase7b-wait-pullback-entry-subsystem.ts.txt");

if (!fs.existsSync(target)) {
  console.error(`Phase 7B demo controller not found: ${target}`);
  process.exit(1);
}
if (!fs.existsSync(templatePath)) {
  console.error(`Phase 7B entry-subsystem template not found: ${templatePath}`);
  process.exit(1);
}

const sourceRaw = fs.readFileSync(target, "utf8");
const sourceUsesCrLf = sourceRaw.includes("\r\n");
let source = sourceRaw.replace(/\r\n/g, "\n");
if (
  source.includes("PHASE7B_DEMO_STRUCTURAL_SL_GT_10=WAIT_PULLBACK") &&
  source.includes("Phase7BPullbackEntryService") &&
  source.includes("pendingPullback")
) {
  console.log("Phase 7B WAIT_PULLBACK demo-controller hook already applied; no changes made.");
  process.exit(0);
}

const backup = `${target}.phase7b-wait-pullback.bak`;
if (!fs.existsSync(backup)) {
  fs.copyFileSync(target, backup);
  console.log(`Backup created: ${backup}`);
}

function replaceOnce(pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Patch anchor not found: ${label}`);
  source = source.replace(pattern, replacement);
}

replaceOnce(
  /import \{[^\n]*type Phase7Bar[^\n]*\} from "@xauusd\/risk-engine";/,
  `import {\n  Phase7BPullbackEntryService,\n  phase7BSupertrend,\n  type Phase7Bar,\n  type Phase7BPendingPullback,\n} from "@xauusd/risk-engine";`,
  "risk-engine import",
);

replaceOnce(
  /type BotState = \{[\s\S]*?\n\};\n\nconst symbol =/,
  `type EntryPattern =\n  | "ENGULFING"\n  | "TWO_CANDLE_BODY_DOMINANCE"\n  | "THREE_CANDLE_BODY_DOMINANCE";\n\ntype EntrySignal = {\n  id: string;\n  side: "BUY" | "SELL";\n  pattern: EntryPattern;\n  signalTimestamp: number;\n  signalEntry: number;\n  structuralStopPrice: number;\n};\n\ntype BotState = {\n  version: 2;\n  accountLogin: number | null;\n  lastEvaluatedM15Close: number;\n  lastEvaluatedM5Close: number;\n  pendingPullback: Phase7BPendingPullback | null;\n  managed: ManagedState | null;\n};\n\nconst symbol =`,
  "BotState",
);

replaceOnce(
  /const ENGULF_BODY_TOLERANCE_PRICE = 0\.1;/,
  `const ENGULF_BODY_TOLERANCE_PRICE = 0.1;\nconst MAX_STRUCTURAL_SL_PRICE = 10;\nconst pullbackWaitMinutes = Math.max(1, Number(process.env.ZIQ_PHASE7B_PULLBACK_WAIT_MINUTES ?? "15"));\nconst pullbackEntryService = new Phase7BPullbackEntryService();`,
  "entry constants",
);

const numericConfigCandidates = [
  "if (![fixedVolume, intervalSeconds, magicNumber, deviationPoints].every((value) => Number.isFinite(value) && value > 0)) {",
  "if (![fixedVolume, intervalSeconds, magicNumber, sidewayMagicNumber, deviationPoints].every((value) => Number.isFinite(value) && value > 0)) {",
];

const numericConfigValidation =
  numericConfigCandidates.find(
    (candidate) =>
      source.includes(candidate),
  );

if (!numericConfigValidation) {
  throw new Error(
    "Patch anchor not found: numeric config validation",
  );
}

const numericConfigWithPullback =
  numericConfigValidation.replace(
    "deviationPoints]",
    "deviationPoints, pullbackWaitMinutes]",
  );

source = source.replace(
  numericConfigValidation,
  numericConfigWithPullback,
);

replaceOnce(
  /console\.log\("PHASE7B_DEMO_STRATEGY=[^"]+"\);/,
  `console.log("PHASE7B_DEMO_STRATEGY=M15_THREE_PATTERN_SUPERTREND_STRUCTURE_RIDER_FVG_CONFIRMATION");`,
  "strategy log",
);
replaceOnce(
  /console\.log\("PHASE7B_DEMO_ENTRY_GATE=[^"]+"\);/,
  `console.log("PHASE7B_DEMO_ENTRY_GATE=3_PATTERNS_PLUS_SUPERTREND_M15_M5_10_3");\nconsole.log("PHASE7B_DEMO_SUPERTREND=M15_M5_10_3");`,
  "entry gate log",
);
replaceOnce(
  /console\.log\("PHASE7B_DEMO_INITIAL_SL=PRICE_DISTANCE_CLAMPED_6_TO_10"\);/,
  `console.log("PHASE7B_DEMO_INITIAL_SL=ORIGINAL_PATTERN_EXTREME_FIXED");\nconsole.log("PHASE7B_DEMO_STRUCTURAL_SL_LE_10=ENTRY_IMMEDIATE");\nconsole.log("PHASE7B_DEMO_STRUCTURAL_SL_GT_10=WAIT_PULLBACK");\nconsole.log(\`PHASE7B_DEMO_PULLBACK_WAIT_MINUTES=\${pullbackWaitMinutes}\`);\nconsole.log("PHASE7B_DEMO_PULLBACK_INVALIDATE=STRUCTURE_BREAK_OR_M15_ST_FLIP_OR_M5_ST_FLIP_OR_EXPIRY");`,
  "initial SL log",
);

const entryStart = source.indexOf("async function previewLatestSignal(): Promise<void> {");
const entryEnd = source.indexOf("async function managePosition(");
if (entryStart < 0 || entryEnd < 0 || entryEnd <= entryStart) {
  throw new Error("Patch anchors not found for Phase 7B entry subsystem.");
}
const entrySubsystem = fs
  .readFileSync(templatePath, "utf8")
  .replace(/\r\n/g, "\n")
  .trimEnd() + "\n\n";
source = source.slice(0, entryStart) + entrySubsystem + source.slice(entryEnd);

const stateStart = source.indexOf("function loadState(file: string): BotState {");
const stateEnd = source.indexOf("function saveState(): void {");
if (stateStart < 0 || stateEnd < 0 || stateEnd <= stateStart) {
  throw new Error("Patch anchors not found for Phase 7B state loader.");
}
const stateLoader = `function loadState(file: string): BotState {\n  if (!fs.existsSync(file)) {\n    return {\n      version: 2,\n      accountLogin: null,\n      lastEvaluatedM15Close: 0,\n      lastEvaluatedM5Close: 0,\n      pendingPullback: null,\n      managed: null,\n    };\n  }\n  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as any;\n  if (parsed.version === 1) {\n    return {\n      version: 2,\n      accountLogin: parsed.accountLogin ?? null,\n      lastEvaluatedM15Close: parsed.lastEvaluatedM15Close ?? 0,\n      lastEvaluatedM5Close: 0,\n      pendingPullback: null,\n      managed: parsed.managed ?? null,\n    };\n  }\n  if (parsed.version !== 2) throw new Error("Unsupported Phase 7B demo state version.");\n  return {\n    version: 2,\n    accountLogin: parsed.accountLogin ?? null,\n    lastEvaluatedM15Close: parsed.lastEvaluatedM15Close ?? 0,\n    lastEvaluatedM5Close: parsed.lastEvaluatedM5Close ?? 0,\n    pendingPullback: parsed.pendingPullback ?? null,\n    managed: parsed.managed ?? null,\n  };\n}\n\n`;
source = source.slice(0, stateStart) + stateLoader + source.slice(stateEnd);

const requiredAssertions = [
  "PHASE7B_DEMO_STRUCTURAL_SL_GT_10=WAIT_PULLBACK",
  "Phase7BPullbackEntryService",
  "phase7BSupertrend",
  "THREE_CANDLE_BODY_DOMINANCE",
  "pendingPullback",
  "ORIGINAL_PATTERN_EXTREME_FIXED",
  "PULLBACK_STILL_TOO_WIDE",
  "PULLBACK_ENTRY",
  "resolveDailyRecoveryPlan",
  "dailyBotMagicNumbers",
  "recoveryTpDistance",
  "recoveryTakeProfit",
];
for (const marker of requiredAssertions) {
  if (!source.includes(marker)) throw new Error(`Post-patch assertion failed: ${marker}`);
}
if (source.includes("PRICE_DISTANCE_CLAMPED_6_TO_10")) {
  throw new Error("Post-patch assertion failed: legacy SL clamp remains.");
}
if (source.includes("PATTERN_PLUS_MA_ONLY")) {
  throw new Error("Post-patch assertion failed: legacy entry gate remains.");
}
if (source.includes("Math.min(10, Math.max(6")) {
  throw new Error("Post-patch assertion failed: legacy 6-to-10 stop clamp remains.");
}

const output = sourceUsesCrLf
  ? source.replace(/\n/g, "\r\n")
  : source;

fs.writeFileSync(target, output, "utf8");
console.log(`Phase 7B WAIT_PULLBACK demo-controller hook applied: ${target}`);
console.log(`Backup: ${backup}`);
console.log("ENTRY_GATE=3_PATTERNS_PLUS_SUPERTREND_M15_M5_10_3");
console.log("STRUCTURAL_SL_LE_10=ENTRY_IMMEDIATE");
console.log("STRUCTURAL_SL_GT_10=WAIT_PULLBACK");
console.log("STRUCTURAL_STOP=ORIGINAL_PATTERN_EXTREME_FIXED");
console.log("REAL_ACCOUNT_GUARD=PRESERVED");
