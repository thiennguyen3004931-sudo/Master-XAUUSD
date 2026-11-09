param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { throw "Missing file: $Path" }
  return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Replace-Required([string]$Text, [string]$Old, [string]$New, [string]$Label) {
  if (-not $Text.Contains($Old)) { throw "Patch anchor missing: $Label" }
  return $Text.Replace($Old, $New)
}

$controller = Join-Path $Root "scripts\run-phase7b-demo-controller.ts"
$launcher = Join-Path $Root "scripts\run-phase7b-demo-local.ps1"
$route = Join-Path $Root "apps\api\src\routes\phase7b-demo.route.ts"
$page = Join-Path $Root "apps\web\src\pages\Phase7BDemoPage.tsx"
$telegram = Join-Path $Root "scripts\run-phase7b-telegram-notifier.mjs"
$telegramOnline = Join-Path $Root "scripts\run-phase7b-bot-online-telegram.ps1"

# -----------------------------------------------------------------------------
# Controller: closed M15 pattern + M15 Supertrend + aligned fresh M5 flip <= 1
# (research label M5_FLIP_2). No MA/EMA/FVG entry gate. Canonical management is
# intentionally preserved for DEMO forward observation.
# -----------------------------------------------------------------------------
$text = Read-Text $controller
if (-not $text.Contains("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2")) {
  $text = Replace-Required $text `
@'
const symbol = process.env.ZIQ_DEMO_SYMBOL ?? "XAUUSD";
'@ `
@'
type DemoSignal = Phase7BSignal & {
  m15SupertrendDirection: 1 | -1;
  m5SupertrendDirection: 1 | -1;
  m5FlipAgeBars: number;
};

const symbol = process.env.ZIQ_DEMO_SYMBOL ?? "XAUUSD";
'@ "controller DemoSignal"

  $text = Replace-Required $text `
@'
console.log("PHASE7B_DEMO_STRATEGY=M15_DUAL_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION");
'@ `
@'
console.log("PHASE7B_DEMO_STRATEGY=M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER");
'@ "controller strategy name"
  $text = Replace-Required $text 'console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_MA_ONLY");' 'console.log("PHASE7B_DEMO_ENTRY_GATE=PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2");' "controller entry gate"
  $text = Replace-Required $text 'console.log("PHASE7B_DEMO_FVG_ROLE=HOLD_CONFIRMATION_PLUS_ADDON_SHADOW");' 'console.log("PHASE7B_DEMO_FVG_ROLE=ENTRY_CONTEXT_ONLY_PLUS_EXISTING_CANONICAL_MANAGEMENT_CONTEXT");' "controller fvg role"
  $text = Replace-Required $text 'console.log("PHASE7B_DEMO_POST_PLUS10_SL=M15_CONFIRMED_SWING_STRUCTURE_ONLY_TIGHTEN");' 'console.log("PHASE7B_DEMO_POST_PLUS10_SL=CANONICAL_M15_STRUCTURE_TIGHTEN");' "controller management label"
  $text = Replace-Required $text 'console.log("PHASE7B_DEMO_FIXED_TP=OFF");' 'console.log("PHASE7B_DEMO_FIXED_TP=OFF");`nconsole.log("PHASE7B_DEMO_MA_ENTRY_FILTER=OFF");`nconsole.log("PHASE7B_DEMO_EMA_ENTRY_FILTER=OFF");`nconsole.log("PHASE7B_DEMO_HTF_HARD_TP=OFF");`nconsole.log("PHASE7B_DEMO_SIGNAL_DATA=CLOSED_M15_AND_CLOSED_M5_ONLY");' "controller safety labels"

  $oldPreview = @'
  const [m15, spec] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
  ]);
  const signal = latestSignal(m15, spec);
'@
  $newPreview = @'
  const [m15, m5, spec] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=1000`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
  ]);
  const signal = latestSignal(m15, m5, spec);
'@
  $text = Replace-Required $text $oldPreview $newPreview "controller preview M5"
  $text = Replace-Required $text `
'console.log(`PHASE7B_DEMO_LATEST_SIGNAL=${signal.side}|PATTERN=${signal.pattern}|ENTRY=${signal.entry}|SL_DISTANCE=${signal.stopDistance}|FVG_CONFIRM=${fvgConfirmed ? "YES" : "NO"}`);' `
'console.log(`PHASE7B_DEMO_LATEST_SIGNAL=${signal.side}|PATTERN=${signal.pattern}|ENTRY=${signal.entry}|SL_DISTANCE=${signal.stopDistance}|M15_ST=${signal.m15SupertrendDirection}|M5_ST=${signal.m5SupertrendDirection}|M5_FLIP_AGE=${signal.m5FlipAgeBars}|FVG_CONTEXT=${fvgConfirmed ? "YES" : "NO"}`);' "controller preview output"

  $oldCycleFetch = @'
  const [m15, spec, positions, quote] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
    get<Position[]>(`/v1/positions?symbol=${encodeURIComponent(symbol)}`),
    get<Quote>(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);
'@
  $newCycleFetch = @'
  const [m15, m5, spec, positions, quote] = await Promise.all([
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M15&count=320`),
    get<Phase7Bar[]>(`/v1/candles/${encodeURIComponent(symbol)}?timeframe=M5&count=1000`),
    get<SymbolSpec>(`/v1/symbols/${encodeURIComponent(symbol)}/spec`),
    get<Position[]>(`/v1/positions?symbol=${encodeURIComponent(symbol)}`),
    get<Quote>(`/v1/quotes/${encodeURIComponent(symbol)}`),
  ]);
'@
  $text = Replace-Required $text $oldCycleFetch $newCycleFetch "controller cycle M5"
  $text = Replace-Required $text 'const signal = latestSignal(m15, spec);' 'const signal = latestSignal(m15, m5, spec);' "controller cycle signal"
  $text = $text.Replace('entryRule: "PATTERN_PLUS_MA",', 'entryRule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2",')

  $text = Replace-Required $text `
@'
    fvgConfirmedAtEntry,
    fvgRequiredForEntry: false,
'@ `
@'
    m15SupertrendDirection: signal.m15SupertrendDirection,
    m5SupertrendDirection: signal.m5SupertrendDirection,
    m5FlipAgeBars: signal.m5FlipAgeBars,
    fvgConfirmedAtEntry,
    fvgRequiredForEntry: false,
'@ "controller entry journal trend fields"

  $oldSignal = @'
function latestSignal(m15: Phase7Bar[], spec: SymbolSpec): Phase7BSignal | null {
  const index = m15.length - 1;
  if (index < 200) return null;
  const current = m15[index]!;
  const trigger = detectEntryPattern(m15, index);
  if (!trigger) return null;

  const closes = m15.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = smaPeriod(closes, 20);
  const ma50 = smaPeriod(closes, 50);
  const ma200 = smaPeriod(closes, 200);
  if (!trendMatches(trigger.side, current.close, ma20, ma50, ma200)) return null;

  const entry = current.close;
  const structuralStopDistance = trigger.side === "BUY"
    ? entry - trigger.patternExtreme
    : trigger.patternExtreme - entry;
  if (!(structuralStopDistance > 0)) return null;

  const stopDistance = Math.min(10, Math.max(6, structuralStopDistance));
  const stopLoss = trigger.side === "BUY" ? entry - stopDistance : entry + stopDistance;
  const initialRiskUsd = spec.tickSize > 0
    ? Math.abs(entry - stopLoss) / spec.tickSize * spec.effectiveTickValuePerLot * fixedVolume
    : 0;

  return {
    id: `phase7b-demo-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
    side: trigger.side,
    pattern: trigger.pattern,
    signalTimestamp: current.closeTime,
    entry: roundValue(entry, 5),
    patternExtreme: roundValue(trigger.patternExtreme, 5),
    structuralStopDistance: roundValue(structuralStopDistance, 5),
    stopDistance: roundValue(stopDistance, 5),
    stopLoss: roundValue(stopLoss, 5),
    volume: roundValue(fixedVolume, 4),
    initialRiskUsd: roundValue(initialRiskUsd, 4),
    ma20: roundValue(ma20, 5),
    ma50: roundValue(ma50, 5),
    ma200: roundValue(ma200, 5),
  };
}
'@
  $newSignal = @'
function latestSignal(m15: Phase7Bar[], m5: Phase7Bar[], spec: SymbolSpec): DemoSignal | null {
  const index = m15.length - 1;
  if (index < 20 || m5.length < 20) return null;
  const current = m15[index]!;
  const trigger = detectEntryPattern(m15, index);
  if (!trigger) return null;

  const wanted = sideDirection(trigger.side);
  const st15 = demoSupertrend(m15, 10, 3);
  const d15 = st15[index];
  if (d15 !== wanted) return null;

  const m5CloseTimes = m5.map((bar) => bar.closeTime);
  const m5Index = demoUpperBound(m5CloseTimes, current.closeTime) - 1;
  if (m5Index < 1) return null;
  const st5 = demoSupertrend(m5, 10, 3);
  const d5 = st5[m5Index];
  if (d5 !== wanted) return null;
  const flipAge = demoFreshFlipAge(st5, m5Index, wanted);
  if (flipAge === null || flipAge > 1) return null;

  // MA values remain attached only for the unchanged canonical management and
  // diagnostics. They are deliberately absent from the entry decision above.
  const closes = m15.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = smaPeriod(closes, 20);
  const ma50 = smaPeriod(closes, 50);
  const ma200 = m15.length >= 200 ? smaPeriod(closes, 200) : ma50;

  const entry = current.close;
  const structuralStopDistance = trigger.side === "BUY"
    ? entry - trigger.patternExtreme
    : trigger.patternExtreme - entry;
  if (!(structuralStopDistance > 0)) return null;

  const stopDistance = Math.min(10, Math.max(6, structuralStopDistance));
  const stopLoss = trigger.side === "BUY" ? entry - stopDistance : entry + stopDistance;
  const initialRiskUsd = spec.tickSize > 0
    ? Math.abs(entry - stopLoss) / spec.tickSize * spec.effectiveTickValuePerLot * fixedVolume
    : 0;

  return {
    id: `phase7b-demo-${current.closeTime}-${trigger.side}-${trigger.pattern}`,
    side: trigger.side,
    pattern: trigger.pattern,
    signalTimestamp: current.closeTime,
    entry: roundValue(entry, 5),
    patternExtreme: roundValue(trigger.patternExtreme, 5),
    structuralStopDistance: roundValue(structuralStopDistance, 5),
    stopDistance: roundValue(stopDistance, 5),
    stopLoss: roundValue(stopLoss, 5),
    volume: roundValue(fixedVolume, 4),
    initialRiskUsd: roundValue(initialRiskUsd, 4),
    ma20: roundValue(ma20, 5),
    ma50: roundValue(ma50, 5),
    ma200: roundValue(ma200, 5),
    m15SupertrendDirection: d15,
    m5SupertrendDirection: d5,
    m5FlipAgeBars: flipAge,
  };
}

function sideDirection(side: "BUY" | "SELL"): 1 | -1 {
  return side === "BUY" ? 1 : -1;
}

function demoFreshFlipAge(direction: Array<1 | -1 | null>, index: number, wanted: 1 | -1): number | null {
  for (let cursor = index; cursor >= 1; cursor -= 1) {
    if (direction[cursor] === wanted && direction[cursor - 1] === -wanted) return index - cursor;
    if (index - cursor > 100) break;
  }
  return null;
}

function demoUpperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function demoSupertrend(bars: Phase7Bar[], period: number, multiplier: number): Array<1 | -1 | null> {
  const tr = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - bars[index - 1]!.close),
        Math.abs(bar.low - bars[index - 1]!.close),
      ));
  const atr: Array<number | null> = Array(bars.length).fill(null);
  if (bars.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += tr[i]!;
    atr[period - 1] = sum / period;
    for (let i = period; i < bars.length; i += 1) {
      atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
    }
  }
  const upper: Array<number | null> = Array(bars.length).fill(null);
  const lower: Array<number | null> = Array(bars.length).fill(null);
  const direction: Array<1 | -1 | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const a = atr[i];
    if (a === null) continue;
    const hl2 = (bar.high + bar.low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) {
      upper[i] = basicUpper;
      lower[i] = basicLower;
      direction[i] = bar.close >= hl2 ? 1 : -1;
      continue;
    }
    const previous = bars[i - 1]!;
    const prevUpper = upper[i - 1]!;
    const prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || previous.close > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || previous.close < prevLower ? basicLower : prevLower;
    direction[i] = direction[i - 1] === 1
      ? (bar.close < lower[i]! ? -1 : 1)
      : (bar.close > upper[i]! ? 1 : -1);
  }
  return direction;
}
'@
  $text = Replace-Required $text $oldSignal $newSignal "controller latestSignal"
  Write-Text $controller $text
}

# Closed bars only for this forward demo. Keep the hook imported but disabled so
# prior pre-close code cannot expose a forming M15 candle to the controller.
$text = Read-Text $launcher
if (-not $text.Contains('ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"')) {
  $text = Replace-Required $text '$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "true"' '$env:ZIQ_PRE_CLOSE_ENTRY_ENABLED = "false"' "launcher disable preclose"
  $text = Replace-Required $text 'Write-Host "PHASE7B_DEMO_PRE_CLOSE_ENTRY=ENABLED"' 'Write-Host "PHASE7B_DEMO_PRE_CLOSE_ENTRY=DISABLED_CLOSED_BAR_FORWARD"' "launcher preclose label"
  $text = Replace-Required $text 'Write-Host "PHASE7B_DEMO_PRE_CLOSE_CANDLE=FORMING_M15_PROVISIONAL"' 'Write-Host "PHASE7B_DEMO_SIGNAL_CANDLES=CLOSED_M15_AND_CLOSED_M5_ONLY"' "launcher closed-bar label"
  Write-Text $launcher $text
}

# -----------------------------------------------------------------------------
# API diagnostics: expose M15/M5 Supertrend + fresh flip while keeping MA values
# as management context only. FVG remains context, not an entry gate.
# -----------------------------------------------------------------------------
$text = Read-Text $route
if (-not $text.Contains('rule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"')) {
  $text = Replace-Required $text `
@'
    matchedPatternSide: boolean;
  };
'@ `
@'
    matchedPatternSide: boolean;
    m15Supertrend: "BUY" | "SELL" | null;
    m5Supertrend: "BUY" | "SELL" | null;
    m5FlipAgeBars: number | null;
    m5FreshAligned: boolean;
  };
'@ "api diagnostics trend type"
  $text = Replace-Required $text 'rule: "PATTERN_PLUS_MA";' 'rule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2";' "api diagnostics rule type"

  $text = Replace-Required $text `
@'
        name: "M15_DUAL_PATTERN_MA_STRUCTURE_RIDER_FVG_CONFIRMATION",
        trigger: "ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE",
        engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
        trend: "MA20_MA50_MA200_MANDATORY",
        fvg: "OPTIONAL_AT_ENTRY_HOLD_CONFIRMATION_ADDON_SHADOW",
'@ `
@'
        name: "M15_DUAL_PATTERN_SUPERTREND_M5_FLIP2_CANONICAL_RIDER",
        trigger: "ENGULFING_OR_TWO_SAME_COLOR_BODY_DOMINANCE",
        engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
        trend: "M15_SUPERTREND_10_3_PLUS_ALIGNED_FRESH_M5_FLIP_WITHIN_2_CLOSED_BARS",
        fvg: "CONTEXT_ONLY_NOT_ENTRY_GATE",
'@ "api strategy summary"

  $oldFunctions = $text.Substring($text.IndexOf('async function getEntryDiagnostics()'), $text.IndexOf('function detectEntryPattern(') - $text.IndexOf('async function getEntryDiagnostics()'))
  if (-not $oldFunctions.Contains('function buildEntryDiagnostics')) { throw "API diagnostics function block not found." }
  $newFunctions = @'
async function getEntryDiagnostics(): Promise<EntryDiagnostics> {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!baseUrl || !apiKey) throw new Error("Bridge read-only credentials are unavailable to the Phase 7B API.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const headers = { "x-mt5-api-key": apiKey };
    const [m15Response, m5Response] = await Promise.all([
      fetch(`${baseUrl}/v1/candles/XAUUSD?timeframe=M15&count=320`, { headers, signal: controller.signal }),
      fetch(`${baseUrl}/v1/candles/XAUUSD?timeframe=M5&count=1000`, { headers, signal: controller.signal }),
    ]);
    const [m15Text, m5Text] = await Promise.all([m15Response.text(), m5Response.text()]);
    if (!m15Response.ok) throw new Error(`Bridge M15 request failed ${m15Response.status}: ${m15Text}`);
    if (!m5Response.ok) throw new Error(`Bridge M5 request failed ${m5Response.status}: ${m5Text}`);
    return buildEntryDiagnostics(JSON.parse(m15Text) as M15Bar[], JSON.parse(m5Text) as M15Bar[]);
  } finally {
    clearTimeout(timeout);
  }
}

function buildEntryDiagnostics(bars: M15Bar[], m5: M15Bar[]): EntryDiagnostics {
  const index = bars.length - 1;
  if (index < 20) throw new Error(`Need at least 21 closed M15 bars, received ${bars.length}.`);
  if (m5.length < 20) throw new Error(`Need at least 21 closed M5 bars, received ${m5.length}.`);
  const current = bars[index]!;
  if (![current.closeTime, current.open, current.high, current.low, current.close].every(Number.isFinite)) {
    throw new Error("Latest M15 candle is invalid.");
  }

  const closes = bars.slice(0, index + 1).map((bar) => bar.close);
  const ma20 = smaPeriod(closes, 20);
  const ma50 = closes.length >= 50 ? smaPeriod(closes, 50) : ma20;
  const ma200 = closes.length >= 200 ? smaPeriod(closes, 200) : ma50;
  const buyAligned = ma20 > ma50 && ma50 > ma200 && current.close > ma20;
  const sellAligned = ma20 < ma50 && ma50 < ma200 && current.close < ma20;
  const pattern = detectEntryPattern(bars, index);

  const st15 = phase7bSupertrend(bars, 10, 3);
  const st5 = phase7bSupertrend(m5, 10, 3);
  const wanted = pattern?.side === "BUY" ? 1 : pattern?.side === "SELL" ? -1 : null;
  const m5Index = phase7bUpperBound(m5.map((bar) => bar.closeTime), current.closeTime) - 1;
  const d15 = st15[index] ?? null;
  const d5 = m5Index >= 0 ? st5[m5Index] ?? null : null;
  const flipAge = wanted !== null && m5Index >= 1 ? phase7bFreshFlipAge(st5, m5Index, wanted) : null;
  const m5FreshAligned = Boolean(wanted !== null && d5 === wanted && flipAge !== null && flipAge <= 1);
  const matchedPatternSide = Boolean(wanted !== null && d15 === wanted && m5FreshAligned);

  const buyFvg = hasRelevantFvg(bars, index, "BUY", 12);
  const sellFvg = hasRelevantFvg(bars, index, "SELL", 12);
  const sameDirectionConfirmed = pattern?.side === "BUY" ? buyFvg : pattern?.side === "SELL" ? sellFvg : false;
  const structuralStopDistance = pattern
    ? pattern.side === "BUY" ? current.close - pattern.extreme : pattern.extreme - current.close
    : null;
  const validStructure = structuralStopDistance !== null && structuralStopDistance > 0;
  const eligible = Boolean(pattern && matchedPatternSide && validStructure);
  const stopDistance = validStructure && structuralStopDistance !== null ? clamp(structuralStopDistance, 6, 10) : null;

  let reason = `Chưa có Engulfing (sai số thân tối đa ${ENGULF_BODY_TOLERANCE_PRICE.toFixed(2)} giá) hoặc Two-candle body dominance hợp lệ.`;
  if (pattern && d15 !== wanted) {
    reason = `${pattern.side} pattern có nhưng Supertrend M15 chưa cùng hướng.`;
  } else if (pattern && d15 === wanted && !m5FreshAligned) {
    reason = `${pattern.side} pattern + Supertrend M15 đạt nhưng M5 chưa cùng hướng với fresh flip trong 2 nến đóng gần nhất.`;
  } else if (pattern && matchedPatternSide && !validStructure) {
    reason = "Pattern + M15/M5 trend đạt nhưng cấu trúc không tạo được khoảng SL hợp lệ.";
  } else if (eligible) {
    reason = sameDirectionConfirmed
      ? `${pattern!.side} đủ Pattern + Supertrend M15 + M5_FLIP_2; FVG context hiện diện.`
      : `${pattern!.side} đủ Pattern + Supertrend M15 + M5_FLIP_2; FVG không hiện diện nhưng không chặn entry.`;
  }

  return {
    source: "READ_ONLY_BRIDGE_M15",
    closeTime: current.closeTime,
    nextCloseTime: current.closeTime + 15 * 60_000,
    bar: { open: round(current.open, 5), high: round(current.high, 5), low: round(current.low, 5), close: round(current.close, 5) },
    pattern: { matched: Boolean(pattern), name: pattern?.name ?? null, side: pattern?.side ?? null, extreme: pattern ? round(pattern.extreme, 5) : null },
    trend: {
      ma20: round(ma20, 5), ma50: round(ma50, 5), ma200: round(ma200, 5), buyAligned, sellAligned,
      matchedPatternSide,
      m15Supertrend: d15 === 1 ? "BUY" : d15 === -1 ? "SELL" : null,
      m5Supertrend: d5 === 1 ? "BUY" : d5 === -1 ? "SELL" : null,
      m5FlipAgeBars: flipAge,
      m5FreshAligned,
    },
    fvg: { buyConfirmed: buyFvg, sellConfirmed: sellFvg, sameDirectionConfirmed, requiredForEntry: false },
    entry: {
      eligible,
      side: eligible ? pattern!.side : null,
      rule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2",
      referenceEntry: round(current.close, 5),
      structuralStopDistance: structuralStopDistance === null ? null : round(structuralStopDistance, 5),
      stopDistance: stopDistance === null ? null : round(stopDistance, 5),
      reason,
    },
  };
}

function phase7bFreshFlipAge(direction: Array<1 | -1 | null>, index: number, wanted: 1 | -1): number | null {
  for (let cursor = index; cursor >= 1; cursor -= 1) {
    if (direction[cursor] === wanted && direction[cursor - 1] === -wanted) return index - cursor;
    if (index - cursor > 100) break;
  }
  return null;
}

function phase7bUpperBound(values: number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function phase7bSupertrend(bars: M15Bar[], period: number, multiplier: number): Array<1 | -1 | null> {
  const tr = bars.map((bar, index) => index === 0 ? bar.high - bar.low : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1]!.close), Math.abs(bar.low - bars[index - 1]!.close)));
  const atr: Array<number | null> = Array(bars.length).fill(null);
  if (bars.length >= period) {
    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += tr[i]!;
    atr[period - 1] = sum / period;
    for (let i = period; i < bars.length; i += 1) atr[i] = (atr[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  const upper: Array<number | null> = Array(bars.length).fill(null);
  const lower: Array<number | null> = Array(bars.length).fill(null);
  const direction: Array<1 | -1 | null> = Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i += 1) {
    const bar = bars[i]!, a = atr[i];
    if (a === null) continue;
    const hl2 = (bar.high + bar.low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    if (i === period - 1 || upper[i - 1] === null || lower[i - 1] === null || direction[i - 1] === null) {
      upper[i] = basicUpper; lower[i] = basicLower; direction[i] = bar.close >= hl2 ? 1 : -1; continue;
    }
    const previous = bars[i - 1]!, prevUpper = upper[i - 1]!, prevLower = lower[i - 1]!;
    upper[i] = basicUpper < prevUpper || previous.close > prevUpper ? basicUpper : prevUpper;
    lower[i] = basicLower > prevLower || previous.close < prevLower ? basicLower : prevLower;
    direction[i] = direction[i - 1] === 1 ? (bar.close < lower[i]! ? -1 : 1) : (bar.close > upper[i]! ? 1 : -1);
  }
  return direction;
}

'@
  $text = $text.Replace($oldFunctions, $newFunctions)
  Write-Text $route $text
}

# -----------------------------------------------------------------------------
# Web: make the forward monitor match the actual DEMO entry semantics and make
# MA values visibly management-only rather than entry confirmation.
# -----------------------------------------------------------------------------
$text = Read-Text $page
if (-not $text.Contains('label="M15 Supertrend"')) {
  $text = Replace-Required $text `
@'
    matchedPatternSide: boolean;
  };
'@ `
@'
    matchedPatternSide: boolean;
    m15Supertrend: "BUY" | "SELL" | null;
    m5Supertrend: "BUY" | "SELL" | null;
    m5FlipAgeBars: number | null;
    m5FreshAligned: boolean;
  };
'@ "web diagnostics trend type"
  $text = Replace-Required $text 'rule: "PATTERN_PLUS_MA";' 'rule: "PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2";' "web diagnostics rule"
  $text = Replace-Required $text '<Typography variant="h5" fontWeight={800}>Phase 7B Demo Operations</Typography>' '<Typography variant="h5" fontWeight={800}>XAUUSD DEMO Forward Monitor</Typography>' "web title"
  $text = Replace-Required $text 'Theo dõi tài khoản DEMO, điều kiện M15 mà bot đang đọc, trạng thái runtime, lệnh đang quản lý và nhật ký. Trang này không có nút đặt, sửa hoặc đóng lệnh.' 'Theo dõi DEMO theo 2 mô hình Engulfing / Two-candle, Supertrend M15 và fresh M5 flip. FVG, H1/H4 và MA/EMA chỉ là context/management; trang không có nút đặt, sửa hoặc đóng lệnh.' "web subtitle"
  $text = Replace-Required $text 'Rule đang chạy: Pattern M15 + MA20/50/200 đúng trend. FVG không bắt buộc tại entry; FVG cùng hướng dùng cho HOLD confirmation và add-on SHADOW. +6 về Entry · +10 chốt 1/3 · runner theo cấu trúc M15.' 'Rule DEMO: Engulfing hoặc Two-candle + Supertrend M15 cùng hướng + M5 cùng hướng và fresh flip trong 2 nến M5 đóng gần nhất. Không dùng MA/EMA/FVG/H1/H4 làm hard entry gate. +6 về Entry · +10 chốt 1/3 · runner giữ canonical management.' "web rule alert"
  $text = Replace-Required $text '<Typography fontWeight={800}>M15 Strategy Diagnostics</Typography>' '<Typography fontWeight={800}>Entry Diagnostics · M15 + M5</Typography>' "web diagnostics title"
  $text = Replace-Required $text 'Đọc trực tiếp 320 nến M15 từ Bridge · hiển thị đúng dữ liệu mà rule hiện tại đang đánh giá' 'Đọc closed M15 + closed M5 từ Bridge · cùng semantics với controller DEMO' "web diagnostics subtitle"
  $text = Replace-Required $text `
@'
                <Diagnostic label="MA trend" status={diagnostics.trend.matchedPatternSide ? "PASS" : "WAIT"} detail={diagnostics.pattern.side ? `${diagnostics.pattern.side} pattern · MA ${diagnostics.trend.matchedPatternSide ? "đồng thuận" : "chưa đồng thuận"}` : diagnostics.trend.buyAligned ? "MA đang aligned BUY" : diagnostics.trend.sellAligned ? "MA đang aligned SELL" : "MA chưa aligned rõ ràng"} />
'@ `
@'
                <Diagnostic label="M15 Supertrend" status={diagnostics.pattern.side && diagnostics.trend.m15Supertrend === diagnostics.pattern.side ? "PASS" : "WAIT"} detail={`M15 ST(10,3): ${diagnostics.trend.m15Supertrend ?? "—"}`} />
                <Diagnostic label="M5 fresh trend" status={diagnostics.trend.m5FreshAligned ? "PASS" : "WAIT"} detail={`M5 ST: ${diagnostics.trend.m5Supertrend ?? "—"} · flip age ${diagnostics.trend.m5FlipAgeBars ?? "—"}`} />
'@ "web ST diagnostics"
  $text = Replace-Required $text '<Diagnostic label="FVG" status={diagnostics.fvg.sameDirectionConfirmed ? "CONFIRM" : "OPTIONAL"} detail={diagnostics.fvg.sameDirectionConfirmed ? "FVG cùng hướng đã xác nhận" : "Chưa xác nhận · không phải hard gate"} />' '<Diagnostic label="FVG context" status={diagnostics.fvg.sameDirectionConfirmed ? "CONTEXT" : "OPTIONAL"} detail={diagnostics.fvg.sameDirectionConfirmed ? "Có FVG context cùng hướng · không phải entry gate" : "Không có FVG context · không chặn entry"} />' "web fvg diagnostic"
  $text = $text.Replace('<Value label="MA20" value={price(diagnostics.trend.ma20)} />', '<Value label="MA20 · exit context" value={price(diagnostics.trend.ma20)} />')
  $text = $text.Replace('<Value label="MA50" value={price(diagnostics.trend.ma50)} />', '<Value label="MA50 · context" value={price(diagnostics.trend.ma50)} />')
  $text = $text.Replace('<Value label="MA200" value={price(diagnostics.trend.ma200)} />', '<Value label="MA200 · context" value={price(diagnostics.trend.ma200)} />')
  $text = $text.Replace('Bot tiếp tục đánh giá nến M15 đóng theo Pattern + MA. FVG là xác nhận bổ sung.', 'Bot tiếp tục đánh giá closed M15 pattern + Supertrend M15 + fresh aligned M5 flip. FVG chỉ là context.')
  Write-Text $page $text
}

# -----------------------------------------------------------------------------
# Telegram: messages mirror the controller. Notifier remains read-only.
# -----------------------------------------------------------------------------
$text = Read-Text $telegram
if (-not $text.Contains('Supertrend M15 + M5_FLIP_2')) {
  $text = $text.Replace('🟢 Đang chờ tín hiệu Pattern + MA trên M15', '🟢 Đang chờ 2 mô hình + Supertrend M15 + M5_FLIP_2')
  $text = $text.Replace('🧩 FVG: xác nhận bổ sung, không bắt buộc entry', '🧩 FVG: context only · không chặn entry')
  $text = Replace-Required $text `
@'
      line("📦", "Volume", `${value(event.volume)} lot`),
      line("🧩", "FVG", event.fvgConfirmedAtEntry ? "CONFIRMED" : "OPTIONAL"),
'@ `
@'
      line("📦", "Volume", `${value(event.volume)} lot`),
      line("📈", "M15 ST", event.m15SupertrendDirection === 1 ? "BUY" : event.m15SupertrendDirection === -1 ? "SELL" : "—"),
      line("⚡", "M5", `${event.m5SupertrendDirection === 1 ? "BUY" : event.m5SupertrendDirection === -1 ? "SELL" : "—"} · flip age ${value(event.m5FlipAgeBars)}`),
      line("🧩", "FVG context", event.fvgConfirmedAtEntry ? "YES" : "NO · không chặn entry"),
'@ "telegram entry fields"
  $text = $text.Replace('<b>Rule:</b> +6 → BE · +10 → chốt 1/3 · runner swing M15', '<b>Rule:</b> Pattern + ST M15 + M5_FLIP_2 · +6 → BE · +10 → chốt 1/3 · canonical runner')
  Write-Text $telegram $text
}

$text = Read-Text $telegramOnline
if (-not $text.Contains('M5_FLIP_2')) {
  $text = $text.Replace('🧠 <b>Entry:</b> <code>Pattern + MA20/50/200</code>', '🧠 <b>Entry:</b> <code>2 Pattern + ST M15 + M5_FLIP_2</code>')
  $text = $text.Replace('🧩 <b>FVG:</b> <code>Optional tại entry</code>', '🧩 <b>FVG:</b> <code>Context only · không chặn entry</code>')
  Write-Text $telegramOnline $text
}

Write-Host "PHASE7B_FORWARD_SYNC=PASS"
Write-Host "PHASE7B_FORWARD_ENTRY=DUAL_PATTERN_PLUS_M15_SUPERTREND_PLUS_M5_FLIP2"
Write-Host "PHASE7B_FORWARD_MA_ENTRY_FILTER=False"
Write-Host "PHASE7B_FORWARD_EMA_ENTRY_FILTER=False"
Write-Host "PHASE7B_FORWARD_FVG_ENTRY_GATE=False"
Write-Host "PHASE7B_FORWARD_SIGNAL_DATA=CLOSED_M15_AND_CLOSED_M5_ONLY"
Write-Host "PHASE7B_FORWARD_PRE_CLOSE_FORMING_ENTRY=False"
Write-Host "PHASE7B_FORWARD_PLUS6=BREAK_EVEN"
Write-Host "PHASE7B_FORWARD_PLUS10=ONE_THIRD_PARTIAL"
Write-Host "PHASE7B_FORWARD_RUNNER=CANONICAL_MANAGEMENT"
Write-Host "PHASE7B_FORWARD_H1_H4_HARD_TP=False"
Write-Host "PHASE7B_FORWARD_BUY_AND_SELL=DEMO_FORWARD_OBSERVATION"
Write-Host "PHASE7B_FORWARD_REAL_ACCOUNT_ALLOWED=False"
Write-Host "PHASE7B_FORWARD_TELEGRAM=READ_ONLY_NOTIFIER_SYNCED"
