import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_CANONICAL_ENTRY_V3_ROOT
  ? path.resolve(process.env.PHASE7B_CANONICAL_ENTRY_V3_ROOT)
  : process.cwd();

const files = {
  controller: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  api: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  layout: path.join(root, "apps", "web", "src", "ui", "DashboardLayout.tsx"),
  patternPage: path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx"),
  basePatcher: path.join(root, "scripts", "apply-phase7b-supertrend-entry-gates-local.mjs"),
  v2Patcher: path.join(root, "scripts", "apply-phase7b-supertrend-entry-gates-v2-local.mjs"),
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const originals = new Map();
const eols = new Map();
for (const [name, file] of Object.entries(files)) {
  if (name === "basePatcher" || name === "v2Patcher") continue;
  const source = fs.readFileSync(file, "utf8");
  originals.set(name, source);
  eols.set(name, source.includes("\r\n") ? "\r\n" : "\n");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase7b-canonical-entry-v3-"));
const tempFiles = {
  controller: path.join(tempRoot, "scripts", "run-phase7b-demo-controller.ts"),
  api: path.join(tempRoot, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  layout: path.join(tempRoot, "apps", "web", "src", "ui", "DashboardLayout.tsx"),
  patternPage: path.join(tempRoot, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx"),
  basePatcher: path.join(tempRoot, "scripts", "apply-phase7b-supertrend-entry-gates-local.mjs"),
};

for (const file of Object.values(tempFiles)) fs.mkdirSync(path.dirname(file), { recursive: true });
fs.copyFileSync(files.controller, tempFiles.controller);
fs.copyFileSync(files.api, tempFiles.api);
fs.copyFileSync(files.layout, tempFiles.layout);
fs.copyFileSync(files.patternPage, tempFiles.patternPage);
fs.copyFileSync(files.basePatcher, tempFiles.basePatcher);

console.log("PHASE7B_CANONICAL_ENTRY_V3=START");
console.log(`PHASE7B_CANONICAL_ENTRY_V3_ROOT=${root}`);
console.log(`PHASE7B_CANONICAL_ENTRY_V3_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log("PHASE7B_CANONICAL_ENTRY_V3_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE");
console.log("PHASE7B_CANONICAL_ENTRY_V3_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE");
console.log("PHASE7B_CANONICAL_ENTRY_V3_MA200=TREND_MANAGEMENT_HOLD_EXIT_NOT_ENTRY_GATE");
console.log("PHASE7B_CANONICAL_ENTRY_V3_REAL_ACCOUNT_ALLOWED=False");

const v2 = spawnSync(process.execPath, [files.v2Patcher, "--apply"], {
  cwd: root,
  env: {
    ...process.env,
    PHASE7B_SUPERTREND_GATE_PATCH_ROOT: tempRoot,
  },
  encoding: "utf8",
});
if (v2.stdout) process.stdout.write(v2.stdout);
if (v2.stderr) process.stderr.write(v2.stderr);
if (v2.error) throw v2.error;
if (v2.status !== 0) throw new Error(`Supertrend V2 prerequisite failed with exit code ${v2.status}.`);

let controller = normalize(fs.readFileSync(tempFiles.controller, "utf8"));
let api = normalize(fs.readFileSync(tempFiles.api, "utf8"));
let layout = normalize(fs.readFileSync(tempFiles.layout, "utf8"));
let patternPage = normalize(fs.readFileSync(tempFiles.patternPage, "utf8"));

controller = replaceExact(controller,
  `console.log("PHASE7B_DEMO_STRATEGY=M15_TRIPLE_PATTERN_MA_SUPERTREND_STRUCTURE_RIDER_FVG_CONFIRMATION");`,
  `console.log("PHASE7B_DEMO_STRATEGY=M15_TRIPLE_PATTERN_SUPERTREND_STRUCTURE_RIDER_MA_CONFIDENCE_FVG_CONTEXT");`,
  "CONTROLLER_STRATEGY_ROLE",
);
controller = replaceExact(controller,
  `console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5");\nconsole.log("PHASE7B_DEMO_SUPERTREND=M15_10_3_AND_M5_10_3_MANDATORY");\nconsole.log("PHASE7B_DEMO_M5_FLIP_AGE=REFERENCE_ONLY_NOT_ENTRY_GATE");`,
  `console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE");\nconsole.log("PHASE7B_DEMO_SUPERTREND=M15_10_3_AND_M5_10_3_MANDATORY");\nconsole.log("PHASE7B_DEMO_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE");\nconsole.log("PHASE7B_DEMO_MA200=TREND_MANAGEMENT_HOLD_EXIT_NOT_ENTRY_GATE");\nconsole.log("PHASE7B_DEMO_M5_FLIP_AGE=REFERENCE_ONLY_NOT_ENTRY_GATE");`,
  "CONTROLLER_ENTRY_GATE_ROLE",
);
controller = replaceAllRequired(controller,
  `PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5`,
  `PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE`,
  2,
  "CONTROLLER_ENTRY_RULE_ROLE",
);
controller = replaceExact(controller,
  `  if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;\n\n`,
  ``,
  "CONTROLLER_REMOVE_MA_ENTRY_GATE",
);
controller = replaceExact(controller,
  `    const trendStillAligned = trendMatches(managed.side, latest.close, ma20, ma50, ma200);`,
  `    const ma200TrendIntact = managed.side === "BUY" ? latest.close >= ma200 : latest.close <= ma200;`,
  "CONTROLLER_MA200_MANAGEMENT_STATE",
);
controller = replaceExact(controller,
  `    if (sameDirectionFvg && trendStillAligned) {`,
  `    if (sameDirectionFvg && ma200TrendIntact) {`,
  "CONTROLLER_FVG_HOLD_MA200",
);
controller = replaceExact(controller,
  `          reason: "SAME_DIRECTION_FVG_PLUS_MA_WHILE_POSITION_WINNING",`,
  `          reason: "SAME_DIRECTION_FVG_PLUS_MA200_TREND_WHILE_POSITION_WINNING",`,
  "CONTROLLER_FVG_SHADOW_REASON",
);
controller = replaceExact(controller,
  `    const trendBroken = managed.side === "BUY" ? latest.close < ma20 : latest.close > ma20;\n    if (trendBroken) {\n      await closeAll(position, "TREND_MA20", latest.closeTime);\n    }`,
  `    const trendBroken = !ma200TrendIntact;\n    if (trendBroken) {\n      await closeAll(position, "TREND_MA200", latest.closeTime);\n    }`,
  "CONTROLLER_EXIT_MA200",
);

api = replaceExact(api,
  `  const buyAligned = ma20 > ma50 && ma50 > ma200 && current.close > ma20;\n  const sellAligned = ma20 < ma50 && ma50 < ma200 && current.close < ma20;`,
  `  const buyAligned = ma20 > ma50 && current.close > ma20;\n  const sellAligned = ma20 < ma50 && current.close < ma20;`,
  "API_MA20_MA50_CONFIDENCE_ONLY",
);
api = replaceExact(api,
  `  const eligible = Boolean(pattern && matchedPatternSide && supertrendAligned && validStructure);`,
  `  const eligible = Boolean(pattern && supertrendAligned && validStructure);`,
  "API_REMOVE_MA_ENTRY_GATE",
);
api = replaceExact(api,
  `  if (pattern && !matchedPatternSide) {\n    reason = \`${'${pattern.side}'} pattern đã xuất hiện nhưng MA20/50/200 chưa đồng thuận cùng hướng.\`;\n  } else if (pattern && matchedPatternSide && !supertrendAligned) {\n    reason = \`${'${pattern.side}'} Pattern + MA đạt nhưng Supertrend M15/M5 10/3 chưa cùng hướng (M15=${'${m15Supertrend ?? "—"}'}, M5=${'${m5Supertrend ?? "—"}'}).\`;\n  } else if (pattern && matchedPatternSide && !validStructure) {`,
  `  if (pattern && !supertrendAligned) {\n    reason = \`${'${pattern.side}'} pattern đã xuất hiện nhưng Supertrend M15/M5 10/3 chưa cùng hướng (M15=${'${m15Supertrend ?? "—"}'}, M5=${'${m5Supertrend ?? "—"}'}).\`;\n  } else if (pattern && supertrendAligned && !validStructure) {`,
  "API_REASON_NO_MA_GATE",
);
api = replaceExact(api,
  `    reason = "Pattern + MA đạt nhưng cấu trúc không tạo được khoảng SL hợp lệ.";`,
  `    reason = "Pattern + Supertrend M15/M5 đạt nhưng cấu trúc không tạo được khoảng SL hợp lệ.";`,
  "API_STRUCTURE_REASON",
);
api = replaceExact(api,
  `      ? \`${'${pattern!.side}'} đủ Pattern + MA; FVG cùng hướng cũng xác nhận.\`\n      : \`${'${pattern!.side}'} đủ Pattern + MA; FVG chưa xác nhận nhưng không chặn entry.\`;`,
  `      ? \`${'${pattern!.side}'} đủ Pattern + Supertrend M15/M5 + SL cấu trúc; MA20/50 cùng hướng chỉ tăng độ tin cậy; FVG cùng hướng cũng xác nhận.\`\n      : \`${'${pattern!.side}'} đủ Pattern + Supertrend M15/M5 + SL cấu trúc; MA20/50 chỉ là độ tin cậy và FVG không chặn entry.\`;`,
  "API_ELIGIBLE_REASON",
);
api = replaceAllRequired(api,
  `PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5`,
  `PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE`,
  2,
  "API_ENTRY_RULE_ROLE",
);
api = replaceExact(api,
  `  const confidenceLevel: EntryDiagnostics["trend"]["confidenceLevel"] = supertrendAligned\n    ? m15TrendlineReaction && m5TrendlineReaction\n      ? "RẤT_CAO"\n      : m15TrendlineReaction || m5TrendlineReaction\n        ? "CAO"\n        : "TIÊU_CHUẨN"\n    : "CHƯA_ĐÁNH_GIÁ";`,
  `  const confidenceLevel: EntryDiagnostics["trend"]["confidenceLevel"] = supertrendAligned\n    ? matchedPatternSide && (m15TrendlineReaction || m5TrendlineReaction)\n      ? "RẤT_CAO"\n      : matchedPatternSide || m15TrendlineReaction || m5TrendlineReaction\n        ? "CAO"\n        : "TIÊU_CHUẨN"\n    : "CHƯA_ĐÁNH_GIÁ";`,
  "API_CONFIDENCE_MA20_MA50",
);

layout = replaceExact(layout,
  `          Tài khoản thật luôn bị khóa. Rule hiện hành: 3 mô hình nến + Supertrend M15 10/3 + Supertrend M5 10/3; flip age chỉ tham khảo, FVG chỉ là bối cảnh.`,
  `          Tài khoản thật luôn bị khóa. Entry: 3 mô hình nến + Supertrend M15 10/3 + Supertrend M5 10/3 + SL cấu trúc. MA20/50 chỉ tăng độ tin cậy; MA200 dùng giữ/chốt trend; FVG chỉ là bối cảnh.`,
  "LAYOUT_CANONICAL_RULE",
);
layout = replaceExact(layout,
  `    headerSubtitle = "3 mô hình nến → Supertrend M15 10/3 → Supertrend M5 10/3 · flip age chỉ tham khảo · FVG chỉ là bối cảnh";`,
  `    headerSubtitle = "3 mô hình nến → Supertrend M15 10/3 → Supertrend M5 10/3 → SL cấu trúc · MA20/50 = độ tin cậy · MA200 = quản lý trend";`,
  "LAYOUT_HEADER_CANONICAL_RULE",
);

patternPage = replaceExact(patternPage,
  `  trend: {\n    m15Supertrend: Side | null;`,
  `  trend: {\n    ma20?: number;\n    ma50?: number;\n    ma200?: number;\n    matchedPatternSide?: boolean;\n    m15Supertrend: Side | null;`,
  "WEB_CONFIDENCE_TYPE",
);
patternPage = replaceExact(patternPage,
  `              <Typography variant="h6" fontWeight={900}>Độ tin cậy theo phản ứng gần đường Supertrend</Typography>\n              <Typography variant="body2" color="text.secondary" mt={0.5}>Đây là điểm cộng chất lượng, không phải điều kiện bắt buộc để vào lệnh.</Typography>`,
  `              <Typography variant="h6" fontWeight={900}>Độ tin cậy: MA20/MA50 + phản ứng gần đường Supertrend</Typography>\n              <Typography variant="body2" color="text.secondary" mt={0.5}>MA20/50 chỉ xác nhận độ tin cậy, không chặn entry. MA200 không phải entry gate; MA200 dùng xác nhận xu hướng để giữ runner hoặc chốt lệnh.</Typography>`,
  "WEB_CONFIDENCE_COPY",
);
patternPage = replaceExact(patternPage,
  `            <Typography variant="body2" color="text.secondary" fontWeight={700}>\n              ℹ Flip age M5: {d.trend.m5FlipAgeBars ?? "—"} nến. Chỉ để tham khảo độ mới của xu hướng, không phải entry gate.\n            </Typography>`,
  `            <Typography variant="body2" color="text.secondary" fontWeight={700}>\n              ℹ MA20/50: {d.trend.matchedPatternSide ? "CÙNG HƯỚNG MÔ HÌNH" : "CHƯA CÙNG HƯỚNG MÔ HÌNH"}. Chỉ dùng xác nhận độ tin cậy, không phải entry gate.\n            </Typography>\n            <Typography variant="body2" color="text.secondary" fontWeight={700}>\n              ℹ MA200: {d.trend.ma200 === undefined ? "—" : price(d.trend.ma200)}. Dùng cho quản lý xu hướng giữ/chốt runner, không phải entry gate.\n            </Typography>\n            <Typography variant="body2" color="text.secondary" fontWeight={700}>\n              ℹ Flip age M5: {d.trend.m5FlipAgeBars ?? "—"} nến. Chỉ để tham khảo độ mới của xu hướng, không phải entry gate.\n            </Typography>`,
  "WEB_MA_ROLE_INFO",
);
patternPage = replaceExact(patternPage,
  `<Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · phần còn lại tiếp tục runner theo quản lý canonical. H1/H4, FVG và phản ứng trendline chỉ là bối cảnh/độ tin cậy, không phải TP cứng.</Alert>`,
  `<Alert severity="info">Quản lý sau khi khớp: +6 giá → dời SL về hòa vốn · +10 giá → chốt 1/3 · phần còn lại tiếp tục runner. MA200 xác nhận xu hướng để giữ runner hoặc chốt khi xu hướng MA200 bị phá; MA20/50 chỉ là độ tin cậy entry. H1/H4, FVG và phản ứng trendline là bối cảnh, không phải TP cứng.</Alert>`,
  "WEB_MANAGEMENT_MA200_COPY",
);

validate(controller, api, layout, patternPage);

const outputs = { controller, api, layout, patternPage };
const changed = [];
for (const [name, normalizedOutput] of Object.entries(outputs)) {
  const original = originals.get(name);
  const normalizedOriginal = normalize(original);
  if (normalizedOutput !== normalizedOriginal) changed.push(name);
}

console.log(`PHASE7B_CANONICAL_ENTRY_V3_FILES_CHANGED=${changed.length}`);
if (!apply) {
  console.log("PHASE7B_CANONICAL_ENTRY_V3_ORIGINAL_MUTATION=False");
  console.log("PHASE7B_CANONICAL_ENTRY_V3_CHECK=PASS");
  cleanup(tempRoot);
  process.exit(0);
}

for (const name of changed) {
  const file = files[name];
  const original = originals.get(name);
  const backup = `${file}.canonical-entry-v3.bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, "utf8");
  const eol = eols.get(name);
  const output = eol === "\r\n" ? outputs[name].replace(/\n/g, "\r\n") : outputs[name];
  fs.writeFileSync(file, output, "utf8");
  console.log(`PHASE7B_CANONICAL_ENTRY_V3_FILE_UPDATED=${file}`);
  console.log(`PHASE7B_CANONICAL_ENTRY_V3_BACKUP=${backup}`);
}

console.log("PHASE7B_CANONICAL_ENTRY_V3_APPLY=PASS");
console.log("PHASE7B_CANONICAL_ENTRY_V3_LINE_ENDINGS=PRESERVED");
console.log("PHASE7B_CANONICAL_ENTRY_V3_DEMO_ONLY=True");
cleanup(tempRoot);

function normalize(value) {
  return String(value).replace(/\r\n/g, "\n");
}

function replaceExact(source, before, after, name) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${name}: expected exactly one anchor, found ${count}.`);
  console.log(`PHASE7B_CANONICAL_ENTRY_V3_STEP=${name}|PASS`);
  return source.replace(before, after);
}

function replaceAllRequired(source, before, after, expected, name) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${name}: expected ${expected} anchors, found ${count}.`);
  console.log(`PHASE7B_CANONICAL_ENTRY_V3_STEP=${name}|PASS`);
  return source.split(before).join(after);
}

function validate(controller, api, layout, patternPage) {
  const assertions = [
    [controller.includes("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE"), "controller canonical entry gate"],
    [controller.includes("PHASE7B_DEMO_MA20_MA50=CONFIDENCE_ONLY_NOT_ENTRY_GATE"), "controller MA20/50 role"],
    [controller.includes("PHASE7B_DEMO_MA200=TREND_MANAGEMENT_HOLD_EXIT_NOT_ENTRY_GATE"), "controller MA200 role"],
    [!controller.includes("trendMatches(trigger.side, current.close, ma20, ma50, ma200)"), "no MA entry gate"],
    [controller.includes('await closeAll(position, "TREND_MA200", latest.closeTime)'), "MA200 exit"],
    [!controller.includes('await closeAll(position, "TREND_MA20", latest.closeTime)'), "no MA20 exit"],
    [api.includes("const eligible = Boolean(pattern && supertrendAligned && validStructure);"), "API no MA gate"],
    [api.includes("const buyAligned = ma20 > ma50 && current.close > ma20;"), "MA20/50 buy confidence"],
    [api.includes("const sellAligned = ma20 < ma50 && current.close < ma20;"), "MA20/50 sell confidence"],
    [api.includes('rule: "PATTERN_PLUS_SUPERTREND_M15_M5_PLUS_VALID_STRUCTURE"'), "API canonical rule"],
    [layout.includes("MA20/50 chỉ tăng độ tin cậy; MA200 dùng giữ/chốt trend"), "layout MA roles"],
    [patternPage.includes("MA20/50 chỉ xác nhận độ tin cậy, không chặn entry"), "web confidence role"],
    [patternPage.includes("MA200 xác nhận xu hướng để giữ runner hoặc chốt"), "web MA200 management role"],
  ];
  const failed = assertions.filter(([ok]) => !ok);
  if (failed.length) throw new Error(`Canonical V3 validation failed: ${failed.map(([, name]) => name).join(", ")}`);
  console.log("PHASE7B_CANONICAL_ENTRY_V3_VALIDATION=PASS");
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
