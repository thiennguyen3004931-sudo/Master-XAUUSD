import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_CANONICAL_RUNNER_V4_ROOT
  ? path.resolve(process.env.PHASE7B_CANONICAL_RUNNER_V4_ROOT)
  : process.cwd();

const rel = {
  controller: "scripts/run-phase7b-demo-controller.ts",
  api: "apps/api/src/routes/phase7b-demo.route.ts",
  layout: "apps/web/src/ui/DashboardLayout.tsx",
  patternPage: "apps/web/src/pages/Phase7BPatternCheckPage.tsx",
  basePatcher: "scripts/apply-phase7b-supertrend-entry-gates-local.mjs",
  v2Patcher: "scripts/apply-phase7b-supertrend-entry-gates-v2-local.mjs",
  v3Patcher: "scripts/apply-phase7b-canonical-entry-v3-local.mjs",
};

const files = Object.fromEntries(Object.entries(rel).map(([key, value]) => [key, path.join(root, value)]));
for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const targetKeys = ["controller", "api", "layout", "patternPage"];
const originals = new Map();
const eols = new Map();
for (const key of targetKeys) {
  const source = fs.readFileSync(files[key], "utf8");
  originals.set(key, source);
  eols.set(key, source.includes("\r\n") ? "\r\n" : "\n");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase7b-canonical-runner-v4-"));
for (const [key, relative] of Object.entries(rel)) {
  const destination = path.join(tempRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(files[key], destination);
}

console.log("PHASE7B_CANONICAL_RUNNER_V4=START");
console.log(`PHASE7B_CANONICAL_RUNNER_V4_ROOT=${root}`);
console.log(`PHASE7B_CANONICAL_RUNNER_V4_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log("PHASE7B_CANONICAL_RUNNER_V4_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE");
console.log("PHASE7B_CANONICAL_RUNNER_V4_MA20_MA50_ENTRY=CONFIDENCE_ONLY_NOT_ENTRY_GATE");
console.log("PHASE7B_CANONICAL_RUNNER_V4_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING");
console.log("PHASE7B_CANONICAL_RUNNER_V4_RUNNER_EXIT=M15_CLOSE_BREAKS_MA50_AFTER_PLUS10_PARTIAL_ONLY");
console.log("PHASE7B_CANONICAL_RUNNER_V4_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE");
console.log("PHASE7B_CANONICAL_RUNNER_V4_REAL_ACCOUNT_ALLOWED=False");

const v3 = spawnSync(process.execPath, [path.join(tempRoot, rel.v3Patcher), "--apply"], {
  cwd: tempRoot,
  env: {
    ...process.env,
    PHASE7B_CANONICAL_ENTRY_V3_ROOT: tempRoot,
  },
  encoding: "utf8",
});
if (v3.stdout) process.stdout.write(v3.stdout);
if (v3.stderr) process.stderr.write(v3.stderr);
if (v3.error) throw v3.error;
if (v3.status !== 0) throw new Error(`Canonical V3 prerequisite failed with exit code ${v3.status}.`);

let controller = normalize(fs.readFileSync(path.join(tempRoot, rel.controller), "utf8"));
let api = normalize(fs.readFileSync(path.join(tempRoot, rel.api), "utf8"));
let layout = normalize(fs.readFileSync(path.join(tempRoot, rel.layout), "utf8"));
let patternPage = normalize(fs.readFileSync(path.join(tempRoot, rel.patternPage), "utf8"));

controller = replaceExact(
  controller,
  `console.log("PHASE7B_DEMO_MA200=TREND_MANAGEMENT_HOLD_EXIT_NOT_ENTRY_GATE");`,
  `console.log("PHASE7B_DEMO_MA50=RUNNER_HOLD_EXIT_AFTER_PLUS10_PARTIAL_ONLY");\nconsole.log("PHASE7B_DEMO_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING");\nconsole.log("PHASE7B_DEMO_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE");`,
  "CONTROLLER_ROLE_LOGS",
);
controller = replaceExact(
  controller,
  `    const ma200TrendIntact = managed.side === "BUY" ? latest.close >= ma200 : latest.close <= ma200;`,
  `    const ma50TrendIntact = managed.side === "BUY" ? latest.close >= ma50 : latest.close <= ma50;\n    const ma200MacroAligned = managed.side === "BUY" ? latest.close >= ma200 : latest.close <= ma200;`,
  "CONTROLLER_MA50_RUNNER_STATE",
);
controller = replaceExact(
  controller,
  `    if (sameDirectionFvg && ma200TrendIntact) {`,
  `    if (sameDirectionFvg && ma50TrendIntact) {`,
  "CONTROLLER_FVG_HOLD_MA50",
);
controller = replaceExact(
  controller,
  `          reason: "SAME_DIRECTION_FVG_PLUS_MA200_TREND_WHILE_POSITION_WINNING",`,
  `          reason: "SAME_DIRECTION_FVG_PLUS_MA50_TREND_WHILE_POSITION_WINNING",`,
  "CONTROLLER_FVG_SHADOW_REASON_MA50",
);
controller = replaceExact(
  controller,
  `        ma200: roundValue(ma200, 5),`,
  `        ma200: roundValue(ma200, 5),\n        ma50TrendIntact,\n        ma200MacroAligned,`,
  "CONTROLLER_MANAGEMENT_CONTEXT_LOG",
);
controller = replaceExact(
  controller,
  `    const trendBroken = !ma200TrendIntact;\n    if (trendBroken) {\n      await closeAll(position, "TREND_MA200", latest.closeTime);\n    }`,
  `    const runnerTrendBroken = managed.partialApplied && !ma50TrendIntact;\n    if (runnerTrendBroken) {\n      await closeAll(position, "RUNNER_TREND_MA50", latest.closeTime);\n    }`,
  "CONTROLLER_RUNNER_EXIT_MA50_ONLY_AFTER_PARTIAL",
);

api = replaceExact(
  api,
  `    rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE";`,
  `    rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE";`,
  "API_ENTRY_RULE_UNCHANGED",
  true,
);

layout = replaceExact(
  layout,
  `          Tài khoản thật luôn bị khóa. Entry: 3 mô hình nến + Supertrend M15 10/3 + Supertrend M5 10/3 + SL cấu trúc. MA20/50 chỉ tăng độ tin cậy; MA200 dùng giữ/chốt trend; FVG chỉ là bối cảnh.`,
  `          Tài khoản thật luôn bị khóa. Entry: 3 mô hình nến + Supertrend M15 10/3 + Supertrend M5 10/3 + SL cấu trúc. MA20/50 chỉ tăng độ tin cậy. Sau +10 chốt 1/3, runner dời SL theo cấu trúc M15 và chỉ chốt khi M15 đóng phá MA50 ngược hướng. MA200 chỉ xác nhận bối cảnh khung lớn.`,
  "LAYOUT_RUNNER_RULE",
);
layout = replaceExact(
  layout,
  `    headerSubtitle = "3 mô hình nến → Supertrend M15 10/3 → Supertrend M5 10/3 → SL cấu trúc · MA20/50 = độ tin cậy · MA200 = quản lý trend";`,
  `    headerSubtitle = "3 mô hình nến → Supertrend M15 10/3 → Supertrend M5 10/3 → SL cấu trúc · MA20/50 = độ tin cậy · runner: cấu trúc M15 + MA50 · MA200 = khung lớn";`,
  "LAYOUT_HEADER_RUNNER_RULE",
);

patternPage = replaceExact(
  patternPage,
  `              <Typography variant="body2" color="text.secondary" mt={0.5}>MA20/50 chỉ xác nhận độ tin cậy, không chặn entry. MA200 không phải entry gate; MA200 dùng xác nhận xu hướng để giữ runner hoặc chốt lệnh.</Typography>`,
  `              <Typography variant="body2" color="text.secondary" mt={0.5}>MA20/50 chỉ xác nhận độ tin cậy, không chặn entry. Sau +10 chốt 1/3, runner dời SL theo cấu trúc M15; MA50 xác nhận giữ/chốt runner. MA200 chỉ xác nhận xu hướng khung lớn, không phải entry/exit gate.</Typography>`,
  "WEB_CONFIDENCE_COPY_RUNNER",
);
patternPage = replaceExact(
  patternPage,
  `              ℹ MA200: {d.trend.ma200 === undefined ? "—" : price(d.trend.ma200)}. Dùng cho quản lý xu hướng giữ/chốt runner, không phải entry gate.`,
  `              ℹ MA200: {d.trend.ma200 === undefined ? "—" : price(d.trend.ma200)}. Chỉ xác nhận xu hướng khung lớn; không chặn entry và không trực tiếp chốt runner.`,
  "WEB_MA200_MACRO_COPY",
);
patternPage = replaceExact(
  patternPage,
  `      <Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · phần còn lại tiếp tục runner theo quản lý canonical. H1/H4, FVG và phản ứng trendline chỉ là bối cảnh/độ tin cậy, không phải TP cứng.</Alert>`,
  `      <Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · runner còn lại dời SL theo cấu trúc M15 đã xác nhận; tiếp tục giữ khi M15 còn đúng phía MA50 và chốt runner khi M15 đóng phá MA50 ngược hướng. MA200 chỉ xác nhận khung lớn; H1/H4, FVG và phản ứng trendline là bối cảnh/độ tin cậy.</Alert>`,
  "WEB_RUNNER_MANAGEMENT_COPY",
);

validate(controller, api, layout, patternPage);
console.log("PHASE7B_CANONICAL_RUNNER_V4_VALIDATION=PASS");

const finalSources = { controller, api, layout, patternPage };
if (!apply) {
  for (const key of targetKeys) {
    if (fs.readFileSync(files[key], "utf8") !== originals.get(key)) {
      throw new Error(`CHECK_ONLY mutated original ${key}.`);
    }
  }
  console.log("PHASE7B_CANONICAL_RUNNER_V4_ORIGINAL_MUTATION=False");
  console.log("PHASE7B_CANONICAL_RUNNER_V4_CHECK=PASS");
  cleanup();
  process.exit(0);
}

for (const key of targetKeys) {
  const backup = `${files[key]}.canonical-runner-v4.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(files[key], backup);
}
for (const key of targetKeys) {
  const eol = eols.get(key);
  const output = eol === "\r\n" ? finalSources[key].replace(/\n/g, "\r\n") : finalSources[key];
  fs.writeFileSync(files[key], output, "utf8");
  console.log(`PHASE7B_CANONICAL_RUNNER_V4_FILE_UPDATED=${files[key]}`);
  console.log(`PHASE7B_CANONICAL_RUNNER_V4_BACKUP=${files[key]}.canonical-runner-v4.bak`);
}
console.log("PHASE7B_CANONICAL_RUNNER_V4_APPLY=PASS");
console.log("PHASE7B_CANONICAL_RUNNER_V4_LINE_ENDINGS=PRESERVED");
console.log("PHASE7B_CANONICAL_RUNNER_V4_DEMO_ONLY=True");
cleanup();

function normalize(value) {
  return value.replace(/\r\n/g, "\n");
}

function replaceExact(source, from, to, label, allowSame = false) {
  if (allowSame && from === to) {
    if (!source.includes(from)) throw new Error(`${label}: required marker not found.`);
    console.log(`PHASE7B_CANONICAL_RUNNER_V4_STEP=${label}|PRESERVED`);
    return source;
  }
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}.`);
  console.log(`PHASE7B_CANONICAL_RUNNER_V4_STEP=${label}|${apply ? "APPLY" : "NEEDED"}`);
  return source.replace(from, to);
}

function validate(controllerSource, apiSource, layoutSource, patternSource) {
  const requiredController = [
    "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE",
    "PHASE7B_DEMO_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE",
    "PHASE7B_DEMO_MA50=RUNNER_HOLD_EXIT_AFTER_PLUS10_PARTIAL_ONLY",
    "PHASE7B_DEMO_RUNNER_SL=M15_CONFIRMED_STRUCTURE_TRAILING",
    "PHASE7B_DEMO_MA200=MACRO_CONTEXT_ONLY_NOT_ENTRY_OR_EXIT_GATE",
    "latestConfirmedStructureStop",
    "STRUCTURAL_SL_TIGHTEN",
    "const runnerTrendBroken = managed.partialApplied && !ma50TrendIntact;",
    'closeAll(position, "RUNNER_TREND_MA50"',
    "const ma200MacroAligned",
    "const now = Number(quote.timestamp)",
    "THREE_CANDLE_BODY_DOMINANCE",
  ];
  for (const marker of requiredController) {
    if (!controllerSource.includes(marker)) throw new Error(`Controller validation missing: ${marker}`);
  }
  const forbiddenController = [
    'closeAll(position, "TREND_MA20"',
    'closeAll(position, "TREND_MA200"',
    "if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;",
  ];
  for (const marker of forbiddenController) {
    if (controllerSource.includes(marker)) throw new Error(`Controller forbidden marker remains: ${marker}`);
  }
  if (!apiSource.includes("const eligible = Boolean(pattern && supertrendAligned && validStructure);")) {
    throw new Error("API still uses a moving-average entry gate.");
  }
  if (!layoutSource.includes("runner dời SL theo cấu trúc M15")) throw new Error("Layout runner rule missing.");
  if (!patternSource.includes("runner dời SL theo cấu trúc M15")) throw new Error("Pattern page runner rule missing.");
  if (!patternSource.includes("MA200 chỉ xác nhận xu hướng khung lớn")) throw new Error("Pattern page MA200 macro role missing.");
}

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}
