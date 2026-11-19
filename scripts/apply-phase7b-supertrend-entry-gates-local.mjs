import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_SUPERTREND_GATE_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_SUPERTREND_GATE_PATCH_ROOT)
  : process.cwd();

const files = {
  controller: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  api: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  layout: path.join(root, "apps", "web", "src", "ui", "DashboardLayout.tsx"),
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const originals = new Map();
const normalized = new Map();
const eols = new Map();
for (const file of Object.values(files)) {
  const source = fs.readFileSync(file, "utf8");
  originals.set(file, source);
  eols.set(file, source.includes("\r\n") ? "\r\n" : "\n");
  normalized.set(file, source.replace(/\r\n/g, "\n"));
}

const controllerSource = normalized.get(files.controller);
const apiSource = normalized.get(files.api);
if (!controllerSource.includes("THREE_CANDLE_BODY_DOMINANCE")) {
  throw new Error("Trend controller three-candle pattern is missing. Apply the three-candle migration first.");
}
if (!apiSource.includes("THREE_CANDLE_BODY_DOMINANCE")) {
  throw new Error("API three-candle pattern is missing. Apply the three-candle migration first.");
}
if (!apiSource.includes("inferBrokerClockOffset") || !apiSource.includes("normalizeBrokerTimestamp")) {
  throw new Error("API broker clock normalization is missing. Apply the pattern UI clock migration first.");
}

const layoutSource = normalized.get(files.layout);
const supertrendGateAlreadyApplied =
  controllerSource.includes("phase7BSupertrend") &&
  controllerSource.includes("PHASE7B_DEMO_SUPERTREND=M15_10_3_AND_M5_10_3_MANDATORY") &&
  apiSource.includes("phase7BSupertrend") &&
  apiSource.includes("m15Supertrend") &&
  apiSource.includes("m5Supertrend") &&
  layoutSource.includes("ST M15/M5");

if (supertrendGateAlreadyApplied) {
  console.log("PHASE7B_SUPERTREND_GATE_PATCH=START");
  console.log(`PHASE7B_SUPERTREND_GATE_ROOT=${root}`);
  console.log(`PHASE7B_SUPERTREND_GATE_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
  console.log("PHASE7B_SUPERTREND_GATE_RULE=M15_10_3_AND_M5_10_3_MANDATORY_AT_M15_SIGNAL_CLOSE");
  console.log("PHASE7B_SUPERTREND_GATE_CHANGES_NEEDED=0");
  console.log("PHASE7B_SUPERTREND_GATE_CURRENT_CONTROLLER=ALREADY_APPLIED");
  console.log(apply ? "PHASE7B_SUPERTREND_GATE_APPLY=PASS" : "PHASE7B_SUPERTREND_GATE_CHECK=PASS");
  process.exit(0);
}

const plans = [
  patch(
    files.controller,
    "CONTROLLER_SUPERTREND_IMPORT",
    `import { type Phase7Bar, type Phase7BSignal } from "@xauusd/risk-engine";`,
    `import { phase7BSupertrend, type Phase7Bar, type Phase7BSignal } from "@xauusd/risk-engine";`,
  ),
  patch(
    files.controller,
    "CONTROLLER_STRATEGY_LABEL",
    `console.log("PHASE7B_DEMO_STRATEGY=M15_DUAL_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION");`,
    `console.log("PHASE7B_DEMO_STRATEGY=M15_TRIPLE_PATTERN_MA_SUPERTREND_STRUCTURE_RIDER_FVG_CONFIRMATION");`,
  ),
  patch(
    files.controller,
    "CONTROLLER_ENTRY_GATE_LABEL",
    `console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_MA_ONLY");`,
    `console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5");\nconsole.log("PHASE7B_DEMO_SUPERTREND=M15_10_3_AND_M5_10_3_MANDATORY");\nconsole.log("PHASE7B_DEMO_M5_FLIP_AGE=REFERENCE_ONLY_NOT_ENTRY_GATE");`,
  ),
  patch(
    files.controller,
    "CONTROLLER_PREVIEW_FETCH_M5",
    `  const [m15, spec] = await Promise.all([\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M15&count=320\`),\n    get<SymbolSpec>(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n  ]);\n  const signal = latestSignal(m15, spec);`,
    `  const [m15, m5, spec] = await Promise.all([\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M15&count=320\`),\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M5&count=420\`),\n    get<SymbolSpec>(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n  ]);\n  const signal = latestSignal(m15, m5, spec);`,
  ),
  patch(
    files.controller,
    "CONTROLLER_CYCLE_FETCH_M5",
    `  const [m15, spec, positions, quote] = await Promise.all([\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M15&count=320\`),\n    get<SymbolSpec>(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n    get<Position[]>(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`),\n    get<Quote>(\`/v1/quotes/\${encodeURIComponent(symbol)}\`),\n  ]);`,
    `  const [m15, m5, spec, positions, quote] = await Promise.all([\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M15&count=320\`),\n    get<Phase7Bar[]>(\`/v1/candles/\${encodeURIComponent(symbol)}?timeframe=M5&count=420\`),\n    get<SymbolSpec>(\`/v1/symbols/\${encodeURIComponent(symbol)}/spec\`),\n    get<Position[]>(\`/v1/positions?symbol=\${encodeURIComponent(symbol)}\`),\n    get<Quote>(\`/v1/quotes/\${encodeURIComponent(symbol)}\`),\n  ]);`,
  ),
  patch(
    files.controller,
    "CONTROLLER_SIGNAL_CALL",
    `  const signal = latestSignal(m15, spec);`,
    `  const signal = latestSignal(m15, m5, spec);`,
  ),
  patch(
    files.controller,
    "CONTROLLER_NO_SIGNAL_RULE",
    `      entryRule: "PATTERN_PLUS_MA",\n      engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,`,
    `      entryRule: "PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5",\n      supertrend: "M15_10_3_AND_M5_10_3",\n      engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,`,
  ),
  patch(
    files.controller,
    "CONTROLLER_ENTRY_SUBMIT_RULE",
    `    entryRule: "PATTERN_PLUS_MA",\n    engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,`,
    `    entryRule: "PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5",\n    supertrend: "M15_10_3_AND_M5_10_3",\n    engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,`,
  ),
  patch(
    files.controller,
    "CONTROLLER_LATEST_SIGNAL_SIGNATURE",
    `function latestSignal(m15: Phase7Bar[], spec: SymbolSpec): Phase7BSignal | null {`,
    `function latestSignal(m15: Phase7Bar[], m5: Phase7Bar[], spec: SymbolSpec): Phase7BSignal | null {`,
  ),
  patch(
    files.controller,
    "CONTROLLER_SUPERTREND_GATE",
    `  const ma200 = smaPeriod(closes, 200);\n  if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;\n\n  const entry = current.close;`,
    `  const ma200 = smaPeriod(closes, 200);\n  if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;\n\n  const m15Supertrend = phase7BSupertrend(m15.slice(0, index + 1), 10, 3);\n  const m15Direction = m15Supertrend.direction[index] ?? null;\n  const m5SignalIndex = m5.findLastIndex((bar) => bar.closeTime <= current.closeTime);\n  if (m5SignalIndex < 9) return null;\n  const m5AtSignal = m5.slice(0, m5SignalIndex + 1);\n  const m5Supertrend = phase7BSupertrend(m5AtSignal, 10, 3);\n  const m5Direction = m5Supertrend.direction[m5SignalIndex] ?? null;\n  if (m15Direction !== trigger.side || m5Direction !== trigger.side) return null;\n\n  const entry = current.close;`,
  ),
  patch(
    files.api,
    "API_SUPERTREND_IMPORT",
    `import { getMt5Telemetry } from "../services/mt5.service";`,
    `import { phase7BSupertrend, type Phase7Bar } from "@xauusd/risk-engine";\nimport { getMt5Telemetry } from "../services/mt5.service";`,
  ),
  patch(
    files.api,
    "API_TREND_DIAGNOSTIC_TYPE",
    `  trend: {\n    ma20: number;\n    ma50: number;\n    ma200: number;\n    buyAligned: boolean;\n    sellAligned: boolean;\n    matchedPatternSide: boolean;\n  };`,
    `  trend: {\n    ma20: number;\n    ma50: number;\n    ma200: number;\n    buyAligned: boolean;\n    sellAligned: boolean;\n    matchedPatternSide: boolean;\n    m15Supertrend: Phase7BSide | null;\n    m5Supertrend: Phase7BSide | null;\n    m5FlipAgeBars: number | null;\n    m15SupertrendLine: number | null;\n    m5SupertrendLine: number | null;\n    m15TrendlineDistance: number | null;\n    m5TrendlineDistance: number | null;\n    m15TrendlineReaction: boolean;\n    m5TrendlineReaction: boolean;\n    confidenceLevel: "CHƯA_ĐÁNH_GIÁ" | "TIÊU_CHUẨN" | "CAO" | "RẤT_CAO";\n  };`,
  ),
  patch(
    files.api,
    "API_ENTRY_RULE_TYPE",
    `    rule: "PATTERN_PLUS_MA";`,
    `    rule: "PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5";`,
  ),
  patch(
    files.api,
    "API_FETCH_M15_M5",
    `    const response = await fetch(\`${baseUrl}/v1/candles/XAUUSD?timeframe=M15&count=320\`, {\n      headers: { "x-mt5-api-key": apiKey },\n      signal: controller.signal,\n    });\n    const text = await response.text();\n    if (!response.ok) throw new Error(\`Bridge M15 request failed \${response.status}: \${text}\`);\n    const bars = JSON.parse(text) as M15Bar[];\n    return buildEntryDiagnostics(bars, brokerClockOffsetMs);`,
    `    const [m15Response, m5Response] = await Promise.all([\n      fetch(\`${baseUrl}/v1/candles/XAUUSD?timeframe=M15&count=320\`, {\n        headers: { "x-mt5-api-key": apiKey },\n        signal: controller.signal,\n      }),\n      fetch(\`${baseUrl}/v1/candles/XAUUSD?timeframe=M5&count=420\`, {\n        headers: { "x-mt5-api-key": apiKey },\n        signal: controller.signal,\n      }),\n    ]);\n    const [m15Text, m5Text] = await Promise.all([m15Response.text(), m5Response.text()]);\n    if (!m15Response.ok) throw new Error(\`Bridge M15 request failed \${m15Response.status}: \${m15Text}\`);\n    if (!m5Response.ok) throw new Error(\`Bridge M5 request failed \${m5Response.status}: \${m5Text}\`);\n    const m15Bars = JSON.parse(m15Text) as M15Bar[];\n    const m5Bars = JSON.parse(m5Text) as M15Bar[];\n    return buildEntryDiagnostics(m15Bars, m5Bars, brokerClockOffsetMs);`,
  ),
  patch(
    files.api,
    "API_BUILD_SIGNATURE_M5",
    `function buildEntryDiagnostics(bars: M15Bar[], brokerClockOffsetMs: number): EntryDiagnostics {`,
    `function buildEntryDiagnostics(bars: M15Bar[], m5Bars: M15Bar[], brokerClockOffsetMs: number): EntryDiagnostics {`,
  ),
  patch(
    files.api,
    "API_SUPERTREND_DIAGNOSTICS",
    `  const sameDirectionConfirmed = pattern?.side === "BUY" ? buyFvg : pattern?.side === "SELL" ? sellFvg : false;\n\n  const structuralStopDistance = pattern`,
    `  const sameDirectionConfirmed = pattern?.side === "BUY" ? buyFvg : pattern?.side === "SELL" ? sellFvg : false;\n\n  const m15SupertrendResult = phase7BSupertrend(bars as Phase7Bar[], 10, 3);\n  const m15Supertrend = m15SupertrendResult.direction[index] ?? null;\n  const m15SupertrendLine = m15SupertrendResult.line[index] ?? null;\n  const m5SignalIndex = m5Bars.findLastIndex((bar) => bar.closeTime <= current.closeTime);\n  const m5AtSignal = m5SignalIndex >= 0 ? m5Bars.slice(0, m5SignalIndex + 1) : [];\n  const m5SupertrendResult = m5AtSignal.length >= 10\n    ? phase7BSupertrend(m5AtSignal as Phase7Bar[], 10, 3)\n    : { direction: [] as Array<Phase7BSide | null>, line: [] as Array<number | null> };\n  const m5Supertrend = m5SignalIndex >= 0 ? m5SupertrendResult.direction[m5SignalIndex] ?? null : null;\n  const m5SupertrendLine = m5SignalIndex >= 0 ? m5SupertrendResult.line[m5SignalIndex] ?? null : null;\n  const m5SignalBar = m5SignalIndex >= 0 ? m5Bars[m5SignalIndex]! : null;\n  const supertrendAligned = Boolean(pattern && m15Supertrend === pattern.side && m5Supertrend === pattern.side);\n  const m15TrendlineDistance = m15SupertrendLine === null ? null : Math.abs(current.close - m15SupertrendLine);\n  const m5TrendlineDistance = m5SignalBar === null || m5SupertrendLine === null\n    ? null\n    : Math.abs(m5SignalBar.close - m5SupertrendLine);\n  const m15TrendlineReaction = m15SupertrendLine !== null\n    && current.low <= m15SupertrendLine + 1e-9\n    && current.high >= m15SupertrendLine - 1e-9;\n  const m5TrendlineReaction = m5SignalBar !== null\n    && m5SupertrendLine !== null\n    && m5SignalBar.low <= m5SupertrendLine + 1e-9\n    && m5SignalBar.high >= m5SupertrendLine - 1e-9;\n  const m5FlipAgeBars = m5SignalIndex >= 0 && m5Supertrend !== null\n    ? directionAgeBars(m5SupertrendResult.direction, m5SignalIndex, m5Supertrend)\n    : null;\n  const confidenceLevel: EntryDiagnostics["trend"]["confidenceLevel"] = supertrendAligned\n    ? m15TrendlineReaction && m5TrendlineReaction\n      ? "RẤT_CAO"\n      : m15TrendlineReaction || m5TrendlineReaction\n        ? "CAO"\n        : "TIÊU_CHUẨN"\n    : "CHƯA_ĐÁNH_GIÁ";\n\n  const structuralStopDistance = pattern`,
  ),
  patch(
    files.api,
    "API_ELIGIBLE_SUPERTREND",
    `  const eligible = Boolean(pattern && matchedPatternSide && validStructure);`,
    `  const eligible = Boolean(pattern && matchedPatternSide && supertrendAligned && validStructure);`,
  ),
  patch(
    files.api,
    "API_REASON_SUPERTREND",
    `  if (pattern && !matchedPatternSide) {\n    reason = \`${pattern.side} pattern đã xuất hiện nhưng MA20/50/200 chưa đồng thuận cùng hướng.\`;\n  } else if (pattern && matchedPatternSide && !validStructure) {`,
    `  if (pattern && !matchedPatternSide) {\n    reason = \`${pattern.side} pattern đã xuất hiện nhưng MA20/50/200 chưa đồng thuận cùng hướng.\`;\n  } else if (pattern && matchedPatternSide && !supertrendAligned) {\n    reason = \`${pattern.side} Pattern + MA đạt nhưng Supertrend M15/M5 10/3 chưa cùng hướng (M15=\${m15Supertrend ?? "—"}, M5=\${m5Supertrend ?? "—"}).\`;\n  } else if (pattern && matchedPatternSide && !validStructure) {`,
  ),
  patch(
    files.api,
    "API_TREND_RETURN_SUPERTREND",
    `      sellAligned,\n      matchedPatternSide,\n    },`,
    `      sellAligned,\n      matchedPatternSide,\n      m15Supertrend,\n      m5Supertrend,\n      m5FlipAgeBars,\n      m15SupertrendLine: m15SupertrendLine === null ? null : round(m15SupertrendLine, 5),\n      m5SupertrendLine: m5SupertrendLine === null ? null : round(m5SupertrendLine, 5),\n      m15TrendlineDistance: m15TrendlineDistance === null ? null : round(m15TrendlineDistance, 5),\n      m5TrendlineDistance: m5TrendlineDistance === null ? null : round(m5TrendlineDistance, 5),\n      m15TrendlineReaction,\n      m5TrendlineReaction,\n      confidenceLevel,\n    },`,
  ),
  patch(
    files.api,
    "API_ENTRY_RULE_RETURN",
    `      rule: "PATTERN_PLUS_MA",`,
    `      rule: "PATTERN_PLUS_MA_PLUS_SUPERTREND_M15_M5",`,
  ),
  patch(
    files.api,
    "API_DIRECTION_AGE_HELPER",
    `function isBullish(bar: M15Bar): boolean { return bar.close > bar.open; }`,
    `function directionAgeBars(\n  direction: Array<Phase7BSide | null>,\n  index: number,\n  current: Phase7BSide,\n): number {\n  let age = 0;\n  for (let i = index - 1; i >= 0 && direction[i] === current; i -= 1) age += 1;\n  return age;\n}\n\nfunction isBullish(bar: M15Bar): boolean { return bar.close > bar.open; }`,
  ),
  patch(
    files.layout,
    "WEB_LAYOUT_RULE_NOTE",
    `          Tài khoản thật luôn bị khóa. Rule hiện hành: 2 mô hình nến + Supertrend M15 + M5 fresh flip; FVG chỉ là bối cảnh.`,
    `          Tài khoản thật luôn bị khóa. Rule hiện hành: 3 mô hình nến + Supertrend M15 10/3 + Supertrend M5 10/3; flip age chỉ tham khảo, FVG chỉ là bối cảnh.`,
  ),
  patch(
    files.layout,
    "WEB_LAYOUT_HEADER_SUBTITLE",
    `    headerSubtitle = "Mô hình nến → Supertrend M15 → M5 fresh flip · FVG chỉ là bối cảnh";`,
    `    headerSubtitle = "3 mô hình nến → Supertrend M15 10/3 → Supertrend M5 10/3 · flip age chỉ tham khảo · FVG chỉ là bối cảnh";`,
  ),
];

const changes = plans.filter((plan) => plan.changed);
console.log("PHASE7B_SUPERTREND_GATE_PATCH=START");
console.log(`PHASE7B_SUPERTREND_GATE_ROOT=${root}`);
console.log(`PHASE7B_SUPERTREND_GATE_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log("PHASE7B_SUPERTREND_GATE_RULE=M15_10_3_AND_M5_10_3_MANDATORY_AT_M15_SIGNAL_CLOSE");
console.log("PHASE7B_SUPERTREND_GATE_M5_ALIGNMENT=LATEST_CLOSED_M5_AT_OR_BEFORE_M15_SIGNAL_CLOSE_NO_LOOKAHEAD");
console.log("PHASE7B_SUPERTREND_GATE_FLIP_AGE=REFERENCE_ONLY_NOT_GATE");
console.log("PHASE7B_SUPERTREND_GATE_REAL_ACCOUNT_ALLOWED=False");
for (const plan of plans) {
  console.log(`PHASE7B_SUPERTREND_GATE_STEP=${plan.name}|${plan.changed ? (apply ? "APPLY" : "NEEDED") : "ALREADY_APPLIED"}`);
}
console.log(`PHASE7B_SUPERTREND_GATE_CHANGES_NEEDED=${changes.length}`);

if (!apply) {
  console.log("PHASE7B_SUPERTREND_GATE_ORIGINAL_MUTATION=False");
  console.log("PHASE7B_SUPERTREND_GATE_CHECK=PASS");
  if (changes.length) console.log("PHASE7B_SUPERTREND_GATE_NEXT=node scripts/apply-phase7b-supertrend-entry-gates-local.mjs --apply");
  process.exit(0);
}

for (const file of Object.values(files)) {
  const source = normalized.get(file);
  const filePlans = plans.filter((plan) => plan.file === file && plan.changed);
  if (!filePlans.length) continue;
  let output = source;
  for (const plan of filePlans) output = output.replace(plan.before, plan.after);
  normalized.set(file, output);
}

for (const file of Object.values(files)) {
  const before = originals.get(file);
  const normalizedAfter = normalized.get(file);
  const eol = eols.get(file);
  const after = eol === "\r\n" ? normalizedAfter.replace(/\n/g, "\r\n") : normalizedAfter;
  if (after === before) continue;
  const backup = `${file}.supertrend-gate.bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, before, "utf8");
  fs.writeFileSync(file, after, "utf8");
  console.log(`PHASE7B_SUPERTREND_GATE_FILE_UPDATED=${file}`);
  console.log(`PHASE7B_SUPERTREND_GATE_BACKUP=${backup}`);
}

console.log("PHASE7B_SUPERTREND_GATE_APPLY=PASS");
console.log("PHASE7B_SUPERTREND_GATE_LINE_ENDINGS=PRESERVED");
console.log("PHASE7B_SUPERTREND_GATE_DEMO_ONLY=True");

function patch(file, name, before, after) {
  const source = normalized.get(file);
  if (source.includes(after)) return { file, name, before, after, changed: false };
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${name}: expected exactly one source anchor, found ${count}. Refusing to modify ${file}`);
  }
  return { file, name, before, after, changed: true };
}
