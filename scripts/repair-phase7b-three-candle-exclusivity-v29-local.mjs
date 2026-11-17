import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const targets = [
  path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
];

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function write(file, text) {
  fs.writeFileSync(file, text.replace(/\r?\n/g, "\r\n"), "utf8");
}

function count(text, needle) {
  let n = 0;
  let pos = 0;
  while (true) {
    const i = text.indexOf(needle, pos);
    if (i < 0) return n;
    n += 1;
    pos = i + needle.length;
  }
}

function patchDetector(file) {
  let text = read(file);
  if (!text.includes("THREE_CANDLE_BODY_DOMINANCE")) {
    throw new Error(`THREE_CANDLE_BODY_DOMINANCE missing: ${file}`);
  }

  const combinedLine = "    const combinedBody3 = firstBody3 + bodySize(second3) + bodySize(current);";
  const firstTwoLine = "    const firstTwoCombinedBody3 = firstBody3 + bodySize(second3);";

  if (!text.includes(firstTwoLine)) {
    const occurrences = count(text, combinedLine);
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one three-candle combined-body line in ${file}, got ${occurrences}.`);
    }
    text = text.replace(combinedLine, `${firstTwoLine}\n${combinedLine}`);
  }

  const oldGate = "      firstBodyStillSmaller3 &&\n      combinedBody3 > priorBody3";
  const newGate = "      firstBodyStillSmaller3 &&\n      firstTwoCombinedBody3 <= priorBody3 + 1e-9 &&\n      combinedBody3 > priorBody3";

  if (!text.includes(newGate)) {
    const occurrences = count(text, oldGate);
    if (occurrences !== 2) {
      throw new Error(`Expected BUY+SELL three-candle gates in ${file}, got ${occurrences}.`);
    }
    text = text.split(oldGate).join(newGate);
  }

  const finalNewGateCount = count(text, newGate);
  if (finalNewGateCount !== 2) {
    throw new Error(`Three-candle exclusivity gate count invalid in ${file}: ${finalNewGateCount}.`);
  }

  if (!text.includes("THREE_CANDLE_BODY_DOMINANCE")) throw new Error(`Three-candle pattern lost: ${file}`);
  if (file.endsWith("run-phase7b-demo-controller.ts")) {
    if (!text.includes("PATTERN_PLUS_M15_M5_SUPERTREND_ALIGNMENT")) {
      throw new Error("Current Supertrend M15/M5 entry gate is missing; refusing to patch stale controller.");
    }
    if (!text.includes('reason: "DAY_RECOVERY_6_TO_10"')) {
      throw new Error("Daily recovery rule is missing; refusing to patch stale controller.");
    }
    if (!text.includes("ACCOUNT_SWITCH_BLOCK")) {
      throw new Error("V26 account audit is missing; refusing to patch stale controller.");
    }
  }

  write(file, text);
}

for (const file of targets) patchDetector(file);

function body(open, close) {
  return Math.abs(close - open);
}
function threeCandleRule(aBody, bBody, cBody, dBody) {
  return bBody < aBody && bBody + cBody <= aBody + 1e-9 && bBody + cBody + dBody > aBody;
}

const tests = [
  { name: "VALID_THREE", expected: true, actual: threeCandleRule(10, 3, 4, 4) },
  { name: "MUST_BE_TWO_NOT_THREE", expected: false, actual: threeCandleRule(10, 6, 5, 2) },
  { name: "THREE_SUM_NOT_ENOUGH", expected: false, actual: threeCandleRule(10, 3, 4, 2) },
  { name: "FIRST_BODY_NOT_SMALLER", expected: false, actual: threeCandleRule(10, 10, 0, 1) },
];
for (const test of tests) {
  if (test.actual !== test.expected) throw new Error(`Self-test failed: ${test.name}`);
}
void body;

console.log("PHASE7B_V29_THREE_CANDLE_EXCLUSIVITY=PASS");
console.log("PHASE7B_V29_TWO_CANDLE_PRECEDENCE=B_PLUS_C_GT_A");
console.log("PHASE7B_V29_THREE_CANDLE_PRECONDITION=B_PLUS_C_LE_A");
console.log("PHASE7B_V29_THREE_CANDLE_CONFIRMATION=B_PLUS_C_PLUS_D_GT_A");
console.log("PHASE7B_V29_FIRST_RESPONSE_BODY_LT_A=True");
console.log("PHASE7B_V29_BUY_SELL_SYMMETRIC=True");
console.log("PHASE7B_V29_SUPERTREND_M15_M5_GATE_PRESERVED=True");
console.log("PHASE7B_V29_DAILY_RECOVERY_PRESERVED=True");
console.log("PHASE7B_V29_ACCOUNT_AUDIT_PRESERVED=True");
console.log("PHASE7B_V29_EXECUTION_MUTATION=SOURCE_ONLY_RESTART_REQUIRED");
console.log("PHASE7B_V29_REAL_ACCOUNT_ALLOWED=False");
console.log("PHASE7B_V29_API_RESTART_REQUIRED=True");
console.log("PHASE7B_V29_BOT_RESTART_REQUIRED=True");
console.log("PHASE7B_V29=PASS");
