import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_THREE_CANDLE_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_THREE_CANDLE_PATCH_ROOT)
  : process.cwd();

const files = {
  service: path.join(root, "packages", "risk-engine", "src", "services", "Phase7BDualPatternTrendRiderService.ts"),
  test: path.join(root, "packages", "risk-engine", "tests", "Phase7BDualPatternTrendRiderService.test.ts"),
  controller: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  api: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
  web: path.join(root, "apps", "web", "src", "pages", "Phase7BPatternCheckPage.tsx"),
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const patches = [
  patch(files.service, "SERVICE_PATTERN_UNION",
    `export type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";`,
    `export type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";`),

  patch(files.service, "SERVICE_METRIC_TYPE",
    `  engulfingTriggers: number;\n  twoCandleTriggers: number;\n  trendAligned: number;`,
    `  engulfingTriggers: number;\n  twoCandleTriggers: number;\n  threeCandleTriggers: number;\n  trendAligned: number;`),

  patch(files.service, "SERVICE_COUNTER_INIT",
    `    let engulfingTriggers = 0;\n    let twoCandleTriggers = 0;\n    let trendAligned = 0;`,
    `    let engulfingTriggers = 0;\n    let twoCandleTriggers = 0;\n    let threeCandleTriggers = 0;\n    let trendAligned = 0;`),

  patch(files.service, "SERVICE_COUNTER_INCREMENT",
    `      if (trigger.pattern === "ENGULFING") engulfingTriggers += 1;\n      else twoCandleTriggers += 1;`,
    `      if (trigger.pattern === "ENGULFING") engulfingTriggers += 1;\n      else if (trigger.pattern === "TWO_CANDLE_BODY_DOMINANCE") twoCandleTriggers += 1;\n      else threeCandleTriggers += 1;`),

  patch(files.service, "SERVICE_METRICS_CALL",
    `        engulfingTriggers,\n        twoCandleTriggers,\n        trendAligned,`,
    `        engulfingTriggers,\n        twoCandleTriggers,\n        threeCandleTriggers,\n        trendAligned,`),

  patch(files.service, "SERVICE_FORMAT_SUMMARY",
    `    const two = summarize(result.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"));\n    return [`,
    `    const two = summarize(result.trades.filter((trade) => trade.pattern === "TWO_CANDLE_BODY_DOMINANCE"));\n    const three = summarize(result.trades.filter((trade) => trade.pattern === "THREE_CANDLE_BODY_DOMINANCE"));\n    return [`),

  patch(files.service, "SERVICE_FORMAT_STRATEGY",
    `      "PHASE7B_STRATEGY=M15_DUAL_PATTERN_MA_FVG_STRUCTURE_RIDER",\n      "PHASE7B_TRIGGER=ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE",\n      "PHASE7B_TWO_CANDLE_RULE=FIRST_SAME_COLOR_BODY_LT_PREVIOUS_OPPOSITE_BODY_AND_SUM_TWO_GT_PREVIOUS_OPPOSITE_BODY",`,
    `      "PHASE7B_STRATEGY=M15_TRIPLE_PATTERN_MA_FVG_STRUCTURE_RIDER",\n      "PHASE7B_TRIGGER=ENGULFING_OR_TWO_OR_THREE_SAME_COLOR_BODY_DOMINANCE",\n      "PHASE7B_TWO_CANDLE_RULE=FIRST_SAME_COLOR_BODY_LT_PREVIOUS_OPPOSITE_BODY_AND_SUM_TWO_GT_PREVIOUS_OPPOSITE_BODY",\n      "PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_AND_BODY_B_PLUS_C_PLUS_D_GT_BODY_A",`),

  patch(files.service, "SERVICE_FORMAT_TRIGGER_COUNT",
    `      \`PHASE7B_TWO_CANDLE_TRIGGERS=\${m.twoCandleTriggers}\`,\n      \`PHASE7B_TREND_ALIGNED=\${m.trendAligned}\`,`,
    `      \`PHASE7B_TWO_CANDLE_TRIGGERS=\${m.twoCandleTriggers}\`,\n      \`PHASE7B_THREE_CANDLE_TRIGGERS=\${m.threeCandleTriggers}\`,\n      \`PHASE7B_TREND_ALIGNED=\${m.trendAligned}\`,`),

  patch(files.service, "SERVICE_FORMAT_PATTERN_SUMMARY",
    `      \`PHASE7B_PATTERN_TWO_CANDLE=FILLED=\${two.filled}|WR=\${two.winRatePercent}|NET=\${two.netPnl}|PF=\${two.profitFactor ?? "INF"}|EXP=\${two.expectancy}|AVG_R=\${two.averageR}\`,\n      "PHASE7B_NO_LOOKAHEAD_ENTRY=PASS",`,
    `      \`PHASE7B_PATTERN_TWO_CANDLE=FILLED=\${two.filled}|WR=\${two.winRatePercent}|NET=\${two.netPnl}|PF=\${two.profitFactor ?? "INF"}|EXP=\${two.expectancy}|AVG_R=\${two.averageR}\`,\n      \`PHASE7B_PATTERN_THREE_CANDLE=FILLED=\${three.filled}|WR=\${three.winRatePercent}|NET=\${three.netPnl}|PF=\${three.profitFactor ?? "INF"}|EXP=\${three.expectancy}|AVG_R=\${three.averageR}\`,\n      "PHASE7B_NO_LOOKAHEAD_ENTRY=PASS",`),

  patch(files.service, "SERVICE_THREE_CANDLE_DETECT",
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(second) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "TWO_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(priorOpposite.high, first.high, second.high),\n    };\n  }\n  return null;\n}\n\nfunction engulfingSide`,
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(second) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "TWO_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(priorOpposite.high, first.high, second.high),\n    };\n  }\n\n  if (index < 3) return null;\n  const anchor = bars[index - 3]!;\n  const b = bars[index - 2]!;\n  const c = bars[index - 1]!;\n  const d = current;\n  const anchorBody = bodySize(anchor);\n  const threeBodyTotal = bodySize(b) + bodySize(c) + bodySize(d);\n\n  if (\n    isBearish(anchor) &&\n    isBullish(b) &&\n    isBullish(c) &&\n    isBullish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return {\n      side: "BUY",\n      pattern: "THREE_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.min(anchor.low, b.low, c.low, d.low),\n    };\n  }\n  if (\n    isBullish(anchor) &&\n    isBearish(b) &&\n    isBearish(c) &&\n    isBearish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "THREE_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(anchor.high, b.high, c.high, d.high),\n    };\n  }\n  return null;\n}\n\nfunction engulfingSide`),

  patch(files.service, "SERVICE_BUILD_METRICS_SIGNATURE",
    `  engulfingTriggers: number,\n  twoCandleTriggers: number,\n  trendAligned: number,`,
    `  engulfingTriggers: number,\n  twoCandleTriggers: number,\n  threeCandleTriggers: number,\n  trendAligned: number,`),

  patch(files.service, "SERVICE_BUILD_METRICS_RESULT",
    `    engulfingTriggers,\n    twoCandleTriggers,\n    trendAligned,`,
    `    engulfingTriggers,\n    twoCandleTriggers,\n    threeCandleTriggers,\n    trendAligned,`),

  patch(files.controller, "CONTROLLER_THREE_CANDLE_DETECT",
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(current) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "TWO_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(priorOpposite.high, first.high, current.high),\n    };\n  }\n  return null;\n}`,
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(current) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "TWO_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(priorOpposite.high, first.high, current.high),\n    };\n  }\n\n  if (index < 3) return null;\n  const anchor = bars[index - 3]!;\n  const b = bars[index - 2]!;\n  const c = bars[index - 1]!;\n  const d = current;\n  const anchorBody = bodySize(anchor);\n  const threeBodyTotal = bodySize(b) + bodySize(c) + bodySize(d);\n\n  if (\n    isBearish(anchor) &&\n    isBullish(b) &&\n    isBullish(c) &&\n    isBullish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return {\n      side: "BUY",\n      pattern: "THREE_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.min(anchor.low, b.low, c.low, d.low),\n    };\n  }\n  if (\n    isBullish(anchor) &&\n    isBearish(b) &&\n    isBearish(c) &&\n    isBearish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return {\n      side: "SELL",\n      pattern: "THREE_CANDLE_BODY_DOMINANCE",\n      patternExtreme: Math.max(anchor.high, b.high, c.high, d.high),\n    };\n  }\n  return null;\n}`),

  patch(files.api, "API_PATTERN_TYPE",
    `type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE";`,
    `type Phase7BPattern = "ENGULFING" | "TWO_CANDLE_BODY_DOMINANCE" | "THREE_CANDLE_BODY_DOMINANCE";`),

  patch(files.api, "API_STRATEGY_LABEL",
    `        name: "M15_DUAL_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION",\n        trigger: "ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE",`,
    `        name: "M15_TRIPLE_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION",\n        trigger: "ENGULFING_OR_TWO_OR_THREE_SAME_COLOR_BODY_DOMINANCE",`),

  patch(files.api, "API_REASON_TEXT",
    `  let reason = \`Chưa có Engulfing (cho phép sai số thân tối đa \${ENGULF_BODY_TOLERANCE_PRICE.toFixed(2)} giá) hoặc Two-candle hợp lệ: thân nến đầu tiên phải nhỏ hơn thân nến ngược màu trước đó, và tổng hai thân cùng màu phải lớn hơn thân nến trước.\`;`,
    `  let reason = \`Chưa có một trong 3 mô hình: Engulfing (sai số thân tối đa \${ENGULF_BODY_TOLERANCE_PRICE.toFixed(2)} giá), Two-candle hợp lệ, hoặc Three-candle A-B-C-D với B+C+D cùng màu và tổng thân B+C+D > thân A.\`;`),

  patch(files.api, "API_THREE_CANDLE_DETECT",
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(current) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return { side: "SELL", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(priorOpposite.high, first.high, current.high) };\n  }\n  return null;\n}`,
    `  if (\n    isBullish(priorOpposite) &&\n    isBearish(first) &&\n    isBearish(current) &&\n    firstBodyStillSmaller &&\n    combinedBody > priorBody\n  ) {\n    return { side: "SELL", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(priorOpposite.high, first.high, current.high) };\n  }\n\n  if (index < 3) return null;\n  const anchor = bars[index - 3]!;\n  const b = bars[index - 2]!;\n  const c = bars[index - 1]!;\n  const d = current;\n  const anchorBody = bodySize(anchor);\n  const threeBodyTotal = bodySize(b) + bodySize(c) + bodySize(d);\n\n  if (\n    isBearish(anchor) &&\n    isBullish(b) &&\n    isBullish(c) &&\n    isBullish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return { side: "BUY", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.min(anchor.low, b.low, c.low, d.low) };\n  }\n  if (\n    isBullish(anchor) &&\n    isBearish(b) &&\n    isBearish(c) &&\n    isBearish(d) &&\n    threeBodyTotal > anchorBody\n  ) {\n    return { side: "SELL", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.max(anchor.high, b.high, c.high, d.high) };\n  }\n  return null;\n}`),

  patch(files.web, "WEB_PATTERN_NAME",
    `  if (name === "TWO_CANDLE_BODY_DOMINANCE") return "Hai nến thân chiếm ưu thế";\n  return "Chưa có mô hình";`,
    `  if (name === "TWO_CANDLE_BODY_DOMINANCE") return "Hai nến thân chiếm ưu thế";\n  if (name === "THREE_CANDLE_BODY_DOMINANCE") return "Ba nến B+C+D > A";\n  return "Chưa có mô hình";`),

  patch(files.web, "WEB_PATTERN_COUNT_TEXT",
    `        : "Chưa xuất hiện một trong 2 mô hình nến bắt buộc.",`,
    `        : "Chưa xuất hiện một trong 3 mô hình nến bắt buộc.",`),

  patch(files.web, "WEB_PATTERN_WAIT_TEXT",
    `detail={d.pattern.side ? \`Hướng \${tenHuong(d.pattern.side)}\` : "Chờ nến nhấn chìm hoặc hai nến thân chiếm ưu thế"}`,
    `detail={d.pattern.side ? \`Hướng \${tenHuong(d.pattern.side)}\` : "Chờ nhấn chìm, 2 nến thân chiếm ưu thế, hoặc 3 nến B+C+D > A"}`),

  patch(files.test, "TEST_THREE_CANDLE_FIXTURE",
    `function m5TrendMove(signalTimestamp: number, entry: number): Phase7Bar[] {`,
    `function bullishThreeCandleM15(): Phase7Bar[] {\n  const bars = bullishTwoCandleM15();\n\n  // New A-B-C-D pattern: A is bearish; B/C/D are bullish.\n  // Body(A)=1.20 while Body(B)+Body(C)+Body(D)=0.40+0.40+0.50=1.30 > 1.20.\n  // No requirement that Body(B) itself must be smaller than Body(A) for this new pattern.\n  bars[198] = { ...bars[198]!, open: 120.0, high: 120.1, low: 118.7, close: 118.8 };\n  bars[199] = { ...bars[199]!, open: 119.0, high: 119.5, low: 118.9, close: 119.4 };\n  bars[200] = { ...bars[200]!, open: 120.3, high: 120.9, low: 120.2, close: 120.7 };\n  bars[201] = { ...bars[201]!, open: 120.6, high: 121.3, low: 120.0, close: 121.1 };\n  return bars;\n}\n\nfunction bullishThreeCandleM15TooWeak(): Phase7Bar[] {\n  const bars = bullishThreeCandleM15();\n  // Keep A bearish and B/C/D bullish, but total B+C+D = 0.90 <= A = 1.20.\n  bars[199] = { ...bars[199]!, open: 119.0, close: 119.3, high: 119.5, low: 118.9 };\n  bars[200] = { ...bars[200]!, open: 120.3, close: 120.6, high: 120.8, low: 120.2 };\n  bars[201] = { ...bars[201]!, open: 120.6, close: 120.9, high: 121.1, low: 120.0 };\n  return bars;\n}\n\nfunction m5TrendMove(signalTimestamp: number, entry: number): Phase7Bar[] {`),

  patch(files.test, "TEST_THREE_CANDLE_CASES",
    `  it("moves SL to entry at +6 and closes one third at +10 while keeping the remainder", () => {`,
    `  it("accepts the new A-B-C-D bullish pattern when Body(B)+Body(C)+Body(D) > Body(A)", () => {\n    const m15 = bullishThreeCandleM15();\n    const service = new Phase7BDualPatternTrendRiderService({ fvgLookbackBars: 2 });\n    const signalTimestamp = m15.at(-1)!.closeTime;\n    const result = service.run({\n      ...requestMeta,\n      m15Bars: m15,\n      m5Bars: m5TrendMove(signalTimestamp, m15.at(-1)!.close),\n    });\n\n    const threeCandle = result.signals.find((signal) => signal.pattern === "THREE_CANDLE_BODY_DOMINANCE");\n    expect(threeCandle).toBeDefined();\n    expect(threeCandle!.side).toBe("BUY");\n    expect(threeCandle!.patternExtreme).toBe(118.7);\n  });\n\n  it("rejects the new A-B-C-D pattern when Body(B)+Body(C)+Body(D) does not exceed Body(A)", () => {\n    const m15 = bullishThreeCandleM15TooWeak();\n    const service = new Phase7BDualPatternTrendRiderService({ fvgLookbackBars: 2 });\n    const signalTimestamp = m15.at(-1)!.closeTime;\n    const result = service.run({\n      ...requestMeta,\n      m15Bars: m15,\n      m5Bars: m5TrendMove(signalTimestamp, m15.at(-1)!.close),\n    });\n\n    expect(result.signals.filter((signal) => signal.pattern === "THREE_CANDLE_BODY_DOMINANCE")).toHaveLength(0);\n  });\n\n  it("moves SL to entry at +6 and closes one third at +10 while keeping the remainder", () => {`),
];

console.log("PHASE7B_THREE_CANDLE_PATCH=START");
console.log(`PHASE7B_THREE_CANDLE_PATCH_ROOT=${root}`);
console.log(`PHASE7B_THREE_CANDLE_PATCH_MODE=${apply ? "APPLY" : "CHECK_ONLY"}`);
console.log("PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_BODY_B_PLUS_C_PLUS_D_GT_BODY_A");
console.log("PHASE7B_THREE_CANDLE_EXISTING_PATTERNS_PRESERVED=ENGULFING,TWO_CANDLE_BODY_DOMINANCE");

const states = new Map();
for (const file of Object.values(files)) {
  const raw = fs.readFileSync(file, "utf8");
  states.set(file, {
    raw,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
    source: raw.replace(/\r\n/g, "\n"),
  });
}

const webPatternUiSuperseded =
  states.get(files.web)?.source.includes("THREE_CANDLE_BODY_DOMINANCE") ||
  (
    states.get(files.web)?.source.includes("SEMANTIC UI v2") &&
    states.get(files.web)?.source.includes("fetchPhase7CWebStatus")
  );

const patternRuleV2AlreadyApplied = [
  states.get(files.service)?.source.includes(
    "Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.",
  ),
  states.get(files.service)?.source.includes(
    "PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_AND_BODY_B_PLUS_C_LT_BODY_A_AND_BODY_B_PLUS_C_PLUS_D_GT_BODY_A",
  ),
  states.get(files.controller)?.source.includes(
    "Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.",
  ),
  states.get(files.controller)?.source.includes(
    "THREE_CANDLE_BODY_DOMINANCE",
  ),
  states.get(files.test)?.source.includes(
    "THREE_CANDLE_BODY_DOMINANCE",
  ),
  states.get(files.api)?.source.includes(
    "THREE_CANDLE_BODY_DOMINANCE",
  ),
  webPatternUiSuperseded,
].every(Boolean);

if (patternRuleV2AlreadyApplied) {
  console.log(
    "PHASE7B_THREE_CANDLE_SUPERSEDED=PATTERN_RULE_V2",
  );
  console.log(
    "PHASE7B_THREE_CANDLE_CHANGES_NEEDED=0",
  );

  if (apply) {
    console.log(
      "PHASE7B_THREE_CANDLE_APPLY=PASS",
    );
  } else {
    console.log(
      "PHASE7B_THREE_CANDLE_ORIGINAL_MUTATION=False",
    );
    console.log(
      "PHASE7B_THREE_CANDLE_CHECK=PASS",
    );
  }

  process.exit(0);
}

let changesNeeded = 0;
for (const p of patches) {
  const state = states.get(p.file);
  if (!state) throw new Error(`Patch state missing for ${p.file}`);
  if (state.source.includes(p.after)) {
    console.log(`PHASE7B_THREE_CANDLE_PATCH_STEP=${p.label}|ALREADY_APPLIED`);
    continue;
  }
  const count = countOccurrences(state.source, p.before);
  if (count !== 1) {
    throw new Error(`${p.label}: expected exactly one source anchor, found ${count}. Refusing to modify any file.`);
  }
  state.source = state.source.replace(p.before, p.after);
  changesNeeded += 1;
  console.log(`PHASE7B_THREE_CANDLE_PATCH_STEP=${p.label}|${apply ? "APPLY" : "NEEDED"}`);
}

console.log(`PHASE7B_THREE_CANDLE_CHANGES_NEEDED=${changesNeeded}`);

if (!apply) {
  console.log("PHASE7B_THREE_CANDLE_ORIGINAL_MUTATION=False");
  console.log("PHASE7B_THREE_CANDLE_CHECK=PASS");
  if (changesNeeded > 0) console.log("PHASE7B_THREE_CANDLE_NEXT=node scripts/apply-phase7b-three-candle-pattern-local.mjs --apply");
  process.exit(0);
}

// All anchors have been validated before any write. Back up every file that will change,
// then write while preserving its original line-ending convention.
for (const [file, state] of states) {
  const normalizedOriginal = state.raw.replace(/\r\n/g, "\n");
  if (state.source === normalizedOriginal) continue;
  const backup = `${file}.three-candle.bak`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, state.raw, "utf8");
  const output = state.eol === "\r\n" ? state.source.replace(/\n/g, "\r\n") : state.source;
  fs.writeFileSync(file, output, "utf8");
  console.log(`PHASE7B_THREE_CANDLE_FILE_UPDATED=${file}`);
  console.log(`PHASE7B_THREE_CANDLE_BACKUP=${backup}`);
}

console.log("PHASE7B_THREE_CANDLE_APPLY=PASS");
console.log("PHASE7B_THREE_CANDLE_LINE_ENDINGS=PRESERVED");

function patch(file, label, before, after) {
  return { file, label, before, after };
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}
