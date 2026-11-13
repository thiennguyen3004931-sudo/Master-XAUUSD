import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const root = process.env.PHASE7B_PATTERN_V2_PATCH_ROOT
  ? path.resolve(process.env.PHASE7B_PATTERN_V2_PATCH_ROOT)
  : process.cwd();

const files = {
  service: path.join(root, "packages", "risk-engine", "src", "services", "Phase7BDualPatternTrendRiderService.ts"),
  test: path.join(root, "packages", "risk-engine", "tests", "Phase7BDualPatternTrendRiderService.test.ts"),
  controller: path.join(root, "scripts", "run-phase7b-demo-controller.ts"),
  api: path.join(root, "apps", "api", "src", "routes", "phase7b-demo.route.ts"),
};

for (const file of Object.values(files)) {
  if (!fs.existsSync(file)) throw new Error(`Required file not found: ${file}`);
}

const serviceDetect = `function detectPattern(
  bars: readonly Phase7Bar[],
  index: number,
): { side: Phase7Side; pattern: Phase7BPattern; patternExtreme: number } | null {
  const current = bars[index]!;

  // Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.
  // This prevents a shorter/less-specific pattern from consuming a longer valid pattern.
  if (index >= 3) {
    const anchor = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);

    if (
      isBearish(anchor) &&
      isBullish(b) &&
      isBullish(c) &&
      isBullish(d) &&
      bcBodyTotal < anchorBody &&
      bcdBodyTotal > anchorBody
    ) {
      return {
        side: "BUY",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.min(anchor.low, b.low, c.low, d.low),
      };
    }
    if (
      isBullish(anchor) &&
      isBearish(b) &&
      isBearish(c) &&
      isBearish(d) &&
      bcBodyTotal < anchorBody &&
      bcdBodyTotal > anchorBody
    ) {
      return {
        side: "SELL",
        pattern: "THREE_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.max(anchor.high, b.high, c.high, d.high),
      };
    }
  }

  if (index >= 2) {
    const anchor = bars[index - 2]!;
    const b = bars[index - 1]!;
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);

    if (
      isBearish(anchor) &&
      isBullish(b) &&
      isBullish(c) &&
      bBody < anchorBody &&
      bcBodyTotal > anchorBody
    ) {
      return {
        side: "BUY",
        pattern: "TWO_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.min(anchor.low, b.low, c.low),
      };
    }
    if (
      isBullish(anchor) &&
      isBearish(b) &&
      isBearish(c) &&
      bBody < anchorBody &&
      bcBodyTotal > anchorBody
    ) {
      return {
        side: "SELL",
        pattern: "TWO_CANDLE_BODY_DOMINANCE",
        patternExtreme: Math.max(anchor.high, b.high, c.high),
      };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    const engulf = engulfingSide(previous, current);
    if (engulf) {
      return {
        side: engulf,
        pattern: "ENGULFING",
        patternExtreme: engulf === "BUY" ? current.low : current.high,
      };
    }
  }
  return null;
}`;

const controllerDetect = `function detectEntryPattern(
  bars: Phase7Bar[],
  index: number,
): { side: "BUY" | "SELL"; pattern: Phase7BSignal["pattern"]; patternExtreme: number } | null {
  const current = bars[index]!;

  // Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.
  if (index >= 3) {
    const anchor = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) && isBullish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "BUY", pattern: "THREE_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(anchor.low, b.low, c.low, d.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) && isBearish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "SELL", pattern: "THREE_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(anchor.high, b.high, c.high, d.high) };
    }
  }

  if (index >= 2) {
    const anchor = bars[index - 2]!;
    const b = bars[index - 1]!;
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "BUY", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.min(anchor.low, b.low, c.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "SELL", pattern: "TWO_CANDLE_BODY_DOMINANCE", patternExtreme: Math.max(anchor.high, b.high, c.high) };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    if (
      isBearish(previous) && isBullish(current) &&
      current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
      current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
    ) {
      return { side: "BUY", pattern: "ENGULFING", patternExtreme: current.low };
    }
    if (
      isBullish(previous) && isBearish(current) &&
      current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
      current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
    ) {
      return { side: "SELL", pattern: "ENGULFING", patternExtreme: current.high };
    }
  }
  return null;
}`;

const apiDetect = `function detectEntryPattern(
  bars: M15Bar[],
  index: number,
): { side: Phase7BSide; name: Phase7BPattern; extreme: number } | null {
  const current = bars[index]!;

  // Pattern Rule V2 priority: THREE -> TWO -> ENGULFING.
  if (index >= 3) {
    const anchor = bars[index - 3]!;
    const b = bars[index - 2]!;
    const c = bars[index - 1]!;
    const d = current;
    const anchorBody = bodySize(anchor);
    const bcBodyTotal = bodySize(b) + bodySize(c);
    const bcdBodyTotal = bcBodyTotal + bodySize(d);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) && isBullish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "BUY", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.min(anchor.low, b.low, c.low, d.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) && isBearish(d) &&
      bcBodyTotal < anchorBody && bcdBodyTotal > anchorBody
    ) {
      return { side: "SELL", name: "THREE_CANDLE_BODY_DOMINANCE", extreme: Math.max(anchor.high, b.high, c.high, d.high) };
    }
  }

  if (index >= 2) {
    const anchor = bars[index - 2]!;
    const b = bars[index - 1]!;
    const c = current;
    const anchorBody = bodySize(anchor);
    const bBody = bodySize(b);
    const bcBodyTotal = bBody + bodySize(c);

    if (
      isBearish(anchor) && isBullish(b) && isBullish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "BUY", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.min(anchor.low, b.low, c.low) };
    }
    if (
      isBullish(anchor) && isBearish(b) && isBearish(c) &&
      bBody < anchorBody && bcBodyTotal > anchorBody
    ) {
      return { side: "SELL", name: "TWO_CANDLE_BODY_DOMINANCE", extreme: Math.max(anchor.high, b.high, c.high) };
    }
  }

  if (index >= 1) {
    const previous = bars[index - 1]!;
    if (
      isBearish(previous) && isBullish(current) &&
      current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 &&
      current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open
    ) {
      return { side: "BUY", name: "ENGULFING", extreme: current.low };
    }
    if (
      isBullish(previous) && isBearish(current) &&
      current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close &&
      current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9
    ) {
      return { side: "SELL", name: "ENGULFING", extreme: current.high };
    }
  }
  return null;
}`;

const changes = [];
changes.push(replaceFunction(files.service, "detectPattern", serviceDetect));
changes.push(replaceFunction(files.controller, "detectEntryPattern", controllerDetect));
changes.push(replaceFunction(files.api, "detectEntryPattern", apiDetect));
changes.push(replaceText(
  files.service,
  "service rule label",
  "PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_AND_BODY_B_PLUS_C_PLUS_D_GT_BODY_A",
  "PHASE7B_THREE_CANDLE_RULE=A_OPPOSITE_BCD_SAME_COLOR_AND_BODY_B_PLUS_C_LT_BODY_A_AND_BODY_B_PLUS_C_PLUS_D_GT_BODY_A",
));
changes.push(replaceText(
  files.api,
  "API diagnostic reason",
  "Three-candle A-B-C-D với B+C+D cùng màu và tổng thân B+C+D > thân A.",
  "Three-candle A-B-C-D hợp lệ khi B+C < A và B+C+D > A.",
));
changes.push(patchTests(files.test));

const changed = changes.filter((item) => item.changed);
if (!apply) {
  console.log(`PHASE7B_PATTERN_V2_CHECK=${changed.length > 0 ? "PASS" : "ALREADY_APPLIED"}`);
  console.log("PHASE7B_PATTERN_V2_ORIGINAL_MUTATION=False");
  for (const item of changes) console.log(`PHASE7B_PATTERN_V2_TARGET=${item.label}|${item.changed ? "WOULD_CHANGE" : "OK"}`);
  process.exit(0);
}

for (const item of changed) fs.writeFileSync(item.file, item.content, "utf8");
console.log("PHASE7B_PATTERN_V2_APPLY=PASS");
console.log(`PHASE7B_PATTERN_V2_FILES_CHANGED=${new Set(changed.map((item) => item.file)).size}`);
console.log("PHASE7B_PATTERN_V2_TWO_CANDLE=B_LT_A_AND_B_PLUS_C_GT_A");
console.log("PHASE7B_PATTERN_V2_THREE_CANDLE=B_PLUS_C_LT_A_AND_B_PLUS_C_PLUS_D_GT_A");
console.log("PHASE7B_PATTERN_V2_PRIORITY=THREE_THEN_TWO_THEN_ENGULFING");

function replaceFunction(file, functionName, replacement) {
  const source = fs.readFileSync(file, "utf8");
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Function ${functionName} not found in ${file}`);
  const tail = source.slice(start);
  const bodyMatch = /\|\s*null\s*\{/.exec(tail);
  if (!bodyMatch) throw new Error(`Function body for ${functionName} not found.`);
  const openBrace = start + bodyMatch.index + bodyMatch[0].lastIndexOf("{");
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`Closing brace for ${functionName} not found in ${file}`);
  const current = source.slice(start, end);
  if (normalize(current) === normalize(replacement)) return { file, label: `${path.basename(file)}:${functionName}`, changed: false, content: source };
  return {
    file,
    label: `${path.basename(file)}:${functionName}`,
    changed: true,
    content: source.slice(0, start) + replacement + source.slice(end),
  };
}

function replaceText(file, label, from, to) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(to)) return { file, label, changed: false, content: source };
  if (!source.includes(from)) throw new Error(`Expected text for ${label} not found in ${file}`);
  return { file, label, changed: true, content: source.replace(from, to) };
}

function patchTests(file) {
  let source = fs.readFileSync(file, "utf8");
  const label = `${path.basename(file)}:Pattern Rule V2 tests`;
  if (source.includes("rejects three-candle when B+C already equals or exceeds A")) {
    return { file, label, changed: false, content: source };
  }

  source = source.replace(
    "  // No requirement that Body(B) itself must be smaller than Body(A) for this new pattern.\n",
    "  // Canonical V2 also requires Body(B)+Body(C) < Body(A) before D completes the pattern.\n",
  );

  const helperMarker = "function m5TrendMove(signalTimestamp: number, entry: number): Phase7Bar[] {";
  const helper = `function bullishThreeCandlePrematureBreak(): Phase7Bar[] {
  const bars = bullishThreeCandleM15();
  // A=1.20; B=0.70 and C=0.60 => B+C=1.30 >= A before D.
  // Even though B+C+D > A, this MUST NOT be classified as the 3-candle pattern.
  bars[199] = { ...bars[199]!, open: 119.0, close: 119.7, high: 119.9, low: 118.9 };
  bars[200] = { ...bars[200]!, open: 120.0, close: 120.6, high: 120.8, low: 119.9 };
  bars[201] = { ...bars[201]!, open: 120.6, close: 121.1, high: 121.3, low: 120.5 };
  return bars;
}

function bullishThreeCandleEqualityAtBC(): Phase7Bar[] {
  const bars = bullishThreeCandleM15();
  // A=1.20; B=0.60 and C=0.60 => B+C exactly equals A, so strict '<' must fail.
  bars[199] = { ...bars[199]!, open: 119.0, close: 119.6, high: 119.8, low: 118.9 };
  bars[200] = { ...bars[200]!, open: 120.0, close: 120.6, high: 120.8, low: 119.9 };
  bars[201] = { ...bars[201]!, open: 120.6, close: 121.1, high: 121.3, low: 120.5 };
  return bars;
}

`;
  if (!source.includes(helperMarker)) throw new Error(`Test insertion marker not found in ${file}`);
  source = source.replace(helperMarker, helper + helperMarker);

  const testMarker = "  it(\"moves SL to entry at +6 and closes one third at +10 while keeping the remainder\", () => {";
  const tests = `  it("rejects three-candle when B+C already equals or exceeds A", () => {
    const service = new Phase7BDualPatternTrendRiderService({ fvgLookbackBars: 2 });
    for (const m15 of [bullishThreeCandlePrematureBreak(), bullishThreeCandleEqualityAtBC()]) {
      const signalTimestamp = m15.at(-1)!.closeTime;
      const result = service.run({
        ...requestMeta,
        m15Bars: m15,
        m5Bars: m5TrendMove(signalTimestamp, m15.at(-1)!.close),
      });
      expect(result.signals.filter((signal) => signal.pattern === "THREE_CANDLE_BODY_DOMINANCE")).toHaveLength(0);
    }
  });

`;
  if (!source.includes(testMarker)) throw new Error(`Test case insertion marker not found in ${file}`);
  source = source.replace(testMarker, tests + testMarker);
  return { file, label, changed: true, content: source };
}

function normalize(value) {
  return value.replace(/\r\n/g, "\n").trim();
}
