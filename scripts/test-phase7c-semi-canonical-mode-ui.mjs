import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  telegramModeForCallback,
  telegramModeForCommand,
} from "./phase7c-telegram-mode-logic.mjs";

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const web = read("apps", "web", "src", "pages", "Phase7CControlCenterPage.tsx");
const webApi = read("apps", "web", "src", "api.ts");
const webTypes = read("apps", "web", "src", "phase7c-types.ts");
const webExecutionControl = read("apps", "web", "src", "phase7c-execution-control.ts");
const telegramController = read("scripts", "run-phase7c-telegram-mode-controller.mjs");
const semiPlan = read(
  "apps",
  "api",
  "src",
  "services",
  "phase7c-semi-trend-management-plan.service.ts",
);
const semiPlanTest = read(
  "apps",
  "api",
  "src",
  "services",
  "phase7c-semi-trend-management-plan.test.ts",
);

const failures = [];
const requirePattern = (label, source, pattern) => {
  if (!pattern.test(source)) failures.push(label);
};
const requireEqual = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
};

// Existing Telegram modes must remain unchanged while SEMI is added through the same callback parser.
requireEqual("Telegram TREND callback", telegramModeForCallback("p7c:TREND"), "TREND");
requireEqual("Telegram SIDEWAY callback", telegramModeForCallback("p7c:SIDEWAY"), "SIDEWAY");
requireEqual("Telegram PAUSE callback", telegramModeForCallback("p7c:PAUSE"), "PAUSE");
requireEqual("Telegram SEMI callback", telegramModeForCallback("p7c:SEMI"), "SEMI");
requireEqual("Telegram AUTO remains blocked", telegramModeForCallback("p7c:AUTO"), null);
requireEqual("Telegram /trend command unchanged", telegramModeForCommand("/trend"), "TREND");
requireEqual("Telegram /sideway command unchanged", telegramModeForCommand("/sideway"), "SIDEWAY");
requireEqual("Telegram /pause command unchanged", telegramModeForCommand("/pause"), "PAUSE");

// Web exposes all canonical modes. Non-AUTO modes use canonical bot-mode; AUTO must retain its guarded activation path.
requirePattern(
  "Web canonical mode options AUTO/TREND/SIDEWAY/SEMI/PAUSE",
  web,
  /BOT_MODE_OPTIONS\s*=\s*\[[\s\S]*?"AUTO"[\s\S]*?"TREND"[\s\S]*?"SIDEWAY"[\s\S]*?"SEMI"[\s\S]*?"PAUSE"[\s\S]*?\]/,
);
requirePattern(
  "Web selected mode uses shared setPhase7CBotMode mutation",
  web,
  /mutationFn:\s*\(mode:\s*Phase7cControlMode\)\s*=>\s*setPhase7CBotMode\(mode\)/,
);
requirePattern(
  "Web renders canonical mode option buttons",
  web,
  /BOT_MODE_OPTIONS\.map\(\(option\)\s*=>/,
);
requirePattern(
  "Web SEMI explanation",
  web,
  /SEMI = vào lệnh thủ công • SL đầu 6 giá • \+6 → BE • \+10 → chốt 1\/3 • phần còn lại quản lý như Trend/,
);
requirePattern(
  "Web API exposes all canonical control modes",
  webApi,
  /export type Phase7cControlMode = "AUTO" \| "TREND" \| "SIDEWAY" \| "SEMI" \| "PAUSE";/,
);
requirePattern(
  "Web lifecycle/decision type includes SEMI",
  webTypes,
  /export type Phase7CBotExecutionMode\s*=\s*[\s\S]*?"AUTO"[\s\S]*?"TREND"[\s\S]*?"SIDEWAY"[\s\S]*?"SEMI"[\s\S]*?"PAUSE"\s*;/,
);
requirePattern(
  "Web AUTO delegates to existing guarded activation",
  webApi,
  /if \(mode === "AUTO"\)\s*\{[\s\S]*?enablePhase7CAuto\(\)/,
);
requirePattern(
  "Web non-AUTO modes use existing canonical bot-mode endpoint",
  webApi,
  /fetch\(`\$\{API_BASE\}\/api\/v1\/phase7c\/bot-mode`,\s*\{/,
);
requirePattern(
  "Web non-AUTO mode mutation keeps canonical web-control-center source",
  webApi,
  /JSON\.stringify\(\{ mode, source: "web-control-center" \}\)/,
);
requirePattern(
  "Guarded AUTO execution type includes SEMI",
  webExecutionControl,
  /Phase7CBotExecutionMode = "AUTO" \| "TREND" \| "SIDEWAY" \| "SEMI" \| "PAUSE";/,
);
requirePattern(
  "Guarded AUTO response options include SEMI",
  webExecutionControl,
  /options:\s*\["AUTO",\s*"TREND",\s*"SIDEWAY",\s*"SEMI",\s*"PAUSE"\]/,
);

// Telegram exposes SEMI but continues using the existing bot-mode POST path. AUTO remains unavailable here.
requirePattern(
  "Telegram SEMI button",
  telegramController,
  /button\("✋ SEMI",\s*"SEMI"\)/,
);
requirePattern(
  "Telegram SEMI label",
  telegramController,
  /SEMI:\s*"BÁN TỰ ĐỘNG"/,
);
requirePattern(
  "Telegram SEMI explanation",
  telegramController,
  /SEMI = vào lệnh thủ công • SL đầu 6 giá • \+6 → BE • \+10 → chốt 1\/3 • phần còn lại quản lý như Trend/,
);
requirePattern(
  "Telegram canonical bot-mode POST path unchanged",
  telegramController,
  /apiRequest\("POST",\s*"\/api\/v1\/phase7c\/bot-mode",\s*\{ mode, source \}\)/,
);

// Current SEMI plan already inherits Trend management. Lock the approved +6/+10 milestones explicitly.
requirePattern(
  "SEMI fixture initial stop distance is 6",
  semiPlanTest,
  /initialStopDistance:\s*6\s*,/,
);
requirePattern(
  "Trend BE trigger is 1R",
  semiPlan,
  /TREND_BREAK_EVEN_AT_R\s*=\s*1\s*;/,
);
requirePattern(
  "Trend +6 trailing activation remains separate from partial close",
  semiPlan,
  /TREND_TRAILING_ACTIVATE_PRICE\s*=\s*6\s*;/,
);
requirePattern(
  "SEMI partial target remains +10",
  semiPlan,
  /SEMI_PARTIAL_CLOSE_PRICE_GAIN\s*=\s*10\s*;/,
);
requirePattern(
  "SEMI partial close remains one third",
  semiPlan,
  /SEMI_PARTIAL_CLOSE_PERCENT\s*=\s*100\s*\/\s*3\s*;/,
);
requirePattern(
  "Regression proves +6 is not the partial target",
  semiPlanTest,
  /assert\.notEqual\(plan\.management\.partialTargets\[0\]\?\.price, plusSixPrice\)/,
);
requirePattern(
  "Regression proves +10 target for LONG",
  semiPlanTest,
  /partialTargets\[0\]\?\.price,\s*state\.entry \+ 10/,
);
requirePattern(
  "Regression proves one-third partial",
  semiPlanTest,
  /partialTargets\[0\]\?\.closePercent,\s*100\s*\/\s*3/,
);

if (failures.length > 0) {
  console.error("PHASE7C_SEMI_CANONICAL_MODE_UI_CONTRACT=FAIL");
  for (const failure of failures) console.error(`MISSING_OR_CHANGED=${failure}`);
  process.exit(1);
}

console.log("PHASE7C_SEMI_CANONICAL_MODE_UI_CONTRACT=PASS");
console.log("SEMI_ENTRY_POLICY=MANUAL_ONLY");
console.log("SEMI_INITIAL_STOP_DISTANCE=6");
console.log("SEMI_AT_PLUS_6=BE_ONLY_NO_PARTIAL_CLOSE");
console.log("SEMI_AT_PLUS_10=PARTIAL_CLOSE_ONE_THIRD");
console.log("WEB_AUTO_MUTATION=EXISTING_GUARDED_AUTO_ENDPOINT");
console.log("WEB_NON_AUTO_MODE_MUTATION=CANONICAL_EXISTING_BOT_MODE_ENDPOINT");
console.log("TELEGRAM_MODE_MUTATION=CANONICAL_EXISTING_ENDPOINT");
console.log("TELEGRAM_AUTO_PERMISSION=UNCHANGED_BLOCKED");
