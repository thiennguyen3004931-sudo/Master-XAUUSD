import { Timeframe, type Candle } from "@xauusd/market-data";
import { getPhase7CLiveRegime, getPhase7CM15Candles } from "./phase7c-live-regime.service";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";

export type PatternDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type PatternCategory = "CANDLESTICK" | "CHART_STRUCTURE";

export interface DetectedPatternRuleCheck {
  readonly code: string;
  readonly label: string;
  readonly passed: boolean;
  readonly observed: string;
  readonly required: string;
}

export interface DetectedMarketPattern {
  readonly id: string;
  readonly nameVi: string;
  readonly nameEn: string;
  readonly category: PatternCategory;
  readonly direction: PatternDirection;
  readonly status: "ACTIVE" | "FORMING" | "INACTIVE";
  readonly matchScore: number;
  readonly timeframe: "M15" | "M5" | "M15+M5";
  readonly summaryVi: string;
  readonly targetStrategy: "TREND" | "SIDEWAY" | "PAUSE";
  readonly recommendedSide: "BUY" | "SELL" | "WAIT";
  readonly entryZone: { readonly price: number; readonly mode: "ENTRY_IMMEDIATE" | "WAIT_PULLBACK" | "WAIT" } | null;
  readonly stopLossPrice: number | null;
  readonly structuralStopDistance: number | null;
  readonly tp1Price: number | null;
  readonly tp2Price: number | null;
  readonly checks: readonly DetectedPatternRuleCheck[];
}

export interface StrategyOptimizationAdvice {
  readonly currentBotMode: string;
  readonly recommendedBotMode: "AUTO" | "TREND" | "SIDEWAY" | "SEMI" | "PAUSE";
  readonly modeChangeNeeded: boolean;
  readonly recommendedStrategy: "TREND" | "SIDEWAY" | "PAUSE";
  readonly recommendedSide: "BUY" | "SELL" | "WAIT";
  readonly entryExecutionMode: "ENTRY_IMMEDIATE" | "WAIT_PULLBACK" | "BLOCKED_WAIT";
  readonly headlineVi: string;
  readonly rationaleVi: readonly string[];
  readonly recommendedConditions: {
    readonly trend: Record<string, boolean>;
    readonly sideway: Record<string, boolean>;
  };
  readonly riskPlan: {
    readonly recommendedLot: number;
    readonly initialSlPrice: number | null;
    readonly slDistancePrice: number | null;
    readonly breakEvenTriggerPrice: number | null;
    readonly partialCloseTriggerPrice: number | null;
    readonly partialCloseLot: number;
    readonly runnerLot: number;
    readonly takeProfitPrice: number | null;
  };
}

export interface Phase7CPatternAdvisorSnapshot {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly symbol: string;
  readonly timeframe: "M15";
  readonly currentPrice: number;
  readonly activePrimaryPattern: DetectedMarketPattern | null;
  readonly activeCandlestickPattern: DetectedMarketPattern | null;
  readonly activeChartStructurePattern: DetectedMarketPattern | null;
  readonly patterns: readonly DetectedMarketPattern[];
  readonly strategyAdvice: StrategyOptimizationAdvice;
}

const ENGULF_TOLERANCE = 0.1;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function body(bar: Pick<Candle, "open" | "close">): number {
  return Math.abs(bar.close - bar.open);
}

function range(bar: Pick<Candle, "high" | "low">): number {
  return Math.max(1e-9, bar.high - bar.low);
}

function isBull(bar: Pick<Candle, "open" | "close">): boolean {
  return bar.close > bar.open;
}

function isBear(bar: Pick<Candle, "open" | "close">): boolean {
  return bar.close < bar.open;
}

function sma(values: readonly number[], period: number): number {
  if (values.length < period) return values.at(-1) ?? 0;
  const slice = values.slice(-period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}

export function analyzeCandlesAndRecommendStrategy(input: {
  symbol: string;
  candles: readonly Candle[];
  regime: string;
  regimeConfidence: number;
  recommendedMode: string;
  activeMode: string;
  atr: number;
  adx: number | null;
  supplyDemandRange: {
    demand: { low: number; high: number; strength?: number };
    supply: { low: number; high: number; strength?: number };
    width: number;
    position: number;
    quality: number;
  } | null;
  reversal: {
    direction: string;
    side: "BUY" | "SELL";
    timestamp: number;
    level: number;
  } | null;
}): Phase7CPatternAdvisorSnapshot {
  const bars = input.candles;
  const n = bars.length;
  const d = bars[n - 1]!;
  const c = bars[n - 2] ?? d;
  const b = bars[n - 3] ?? c;
  const a = bars[n - 4] ?? b;

  const closes = bars.map((bar) => bar.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const currentPrice = d.close;

  const patterns: DetectedMarketPattern[] = [];

  // 1. THREE_CANDLE_BODY_DOMINANCE (Bullish & Bearish)
  const anchor3Body = body(a);
  const bcBody = body(b) + body(c);
  const bcdBody = bcBody + body(d);
  const bull3Checks: DetectedPatternRuleCheck[] = [
    { code: "ANCHOR_BEAR", label: "Nến neo [A] là nến giảm", passed: isBear(a), observed: isBear(a) ? "BEAR" : "BULL", required: "BEAR" },
    { code: "BCD_BULL", label: "3 nến [B, C, D] cùng tăng", passed: isBull(b) && isBull(c) && isBull(d), observed: `${isBull(b) ? "Tăng" : "Giảm"}/${isBull(c) ? "Tăng" : "Giảm"}/${isBull(d) ? "Tăng" : "Giảm"}`, required: "3 nến Tăng" },
    { code: "BC_LT_A", label: "Tổng thân B + C < Thân A", passed: bcBody < anchor3Body, observed: `${round(bcBody)} < ${round(anchor3Body)}`, required: "Body(B+C) < Body(A)" },
    { code: "BCD_GT_A", label: "Tổng thân B + C + D > Thân A", passed: bcdBody > anchor3Body, observed: `${round(bcdBody)} > ${round(anchor3Body)}`, required: "Body(B+C+D) > Body(A)" },
  ];
  const bull3Score = Math.round((bull3Checks.filter((x) => x.passed).length / bull3Checks.length) * 100);
  const bull3Extreme = Math.min(a.low, b.low, c.low, d.low);
  const bull3StructSl = round(bull3Extreme - 1.0);
  const bull3Dist = round(Math.max(0, currentPrice - bull3StructSl));
  patterns.push({
    id: "BULLISH_THREE_CANDLE_DOMINANCE",
    nameVi: "Mô hình 3 Nến Áp Đảo Tăng (Bullish 3-Candle Dominance)",
    nameEn: "Bullish Three-Candle Body Dominance",
    category: "CANDLESTICK",
    direction: "BULLISH",
    status: bull3Score === 100 ? "ACTIVE" : bull3Score >= 75 ? "FORMING" : "INACTIVE",
    matchScore: bull3Score,
    timeframe: "M15",
    summaryVi: "Ba nến tăng liên tiếp [B, C, D] tích lũy động lượng và bứt phá vượt toàn bộ thân nến giảm neo [A] trước đó.",
    targetStrategy: "TREND",
    recommendedSide: "BUY",
    entryZone: { price: round(currentPrice), mode: bull3Dist > 10 ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice - Math.min(10, Math.max(6, bull3Dist))),
    structuralStopDistance: bull3Dist,
    tp1Price: round(currentPrice + 10),
    tp2Price: round(currentPrice + 22),
    checks: bull3Checks,
  });

  const bear3Checks: DetectedPatternRuleCheck[] = [
    { code: "ANCHOR_BULL", label: "Nến neo [A] là nến tăng", passed: isBull(a), observed: isBull(a) ? "BULL" : "BEAR", required: "BULL" },
    { code: "BCD_BEAR", label: "3 nến [B, C, D] cùng giảm", passed: isBear(b) && isBear(c) && isBear(d), observed: `${isBear(b) ? "Giảm" : "Tăng"}/${isBear(c) ? "Giảm" : "Tăng"}/${isBear(d) ? "Giảm" : "Tăng"}`, required: "3 nến Giảm" },
    { code: "BC_LT_A", label: "Tổng thân B + C < Thân A", passed: bcBody < anchor3Body, observed: `${round(bcBody)} < ${round(anchor3Body)}`, required: "Body(B+C) < Body(A)" },
    { code: "BCD_GT_A", label: "Tổng thân B + C + D > Thân A", passed: bcdBody > anchor3Body, observed: `${round(bcdBody)} > ${round(anchor3Body)}`, required: "Body(B+C+D) > Body(A)" },
  ];
  const bear3Score = Math.round((bear3Checks.filter((x) => x.passed).length / bear3Checks.length) * 100);
  const bear3Extreme = Math.max(a.high, b.high, c.high, d.high);
  const bear3StructSl = round(bear3Extreme + 1.0);
  const bear3Dist = round(Math.max(0, bear3StructSl - currentPrice));
  patterns.push({
    id: "BEARISH_THREE_CANDLE_DOMINANCE",
    nameVi: "Mô hình 3 Nến Áp Đảo Giảm (Bearish 3-Candle Dominance)",
    nameEn: "Bearish Three-Candle Body Dominance",
    category: "CANDLESTICK",
    direction: "BEARISH",
    status: bear3Score === 100 ? "ACTIVE" : bear3Score >= 75 ? "FORMING" : "INACTIVE",
    matchScore: bear3Score,
    timeframe: "M15",
    summaryVi: "Ba nến giảm liên tiếp [B, C, D] nuốt trọn thân nến tăng neo [A], xác nhận phe bán kiểm soát xu hướng.",
    targetStrategy: "TREND",
    recommendedSide: "SELL",
    entryZone: { price: round(currentPrice), mode: bear3Dist > 10 ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice + Math.min(10, Math.max(6, bear3Dist))),
    structuralStopDistance: bear3Dist,
    tp1Price: round(currentPrice - 10),
    tp2Price: round(currentPrice - 22),
    checks: bear3Checks,
  });

  // 2. TWO_CANDLE_BODY_DOMINANCE (Bullish & Bearish)
  const anchor2Body = body(b);
  const cBody = body(c);
  const cdBody = cBody + body(d);
  const bull2Checks: DetectedPatternRuleCheck[] = [
    { code: "A_BEAR", label: "Nến neo giảm", passed: isBear(b), observed: isBear(b) ? "BEAR" : "BULL", required: "BEAR" },
    { code: "CD_BULL", label: "2 nến kế tiếp cùng tăng", passed: isBull(c) && isBull(d), observed: `${isBull(c) ? "Tăng" : "Giảm"}/${isBull(d) ? "Tăng" : "Giảm"}`, required: "2 nến Tăng" },
    { code: "C_LT_B", label: "Thân nến 1 < Thân nến neo", passed: cBody < anchor2Body, observed: `${round(cBody)} < ${round(anchor2Body)}`, required: "Body(1) < Body(Anchor)" },
    { code: "CD_GT_B", label: "Tổng 2 thân nến > Thân nến neo", passed: cdBody > anchor2Body, observed: `${round(cdBody)} > ${round(anchor2Body)}`, required: "Body(1+2) > Body(Anchor)" },
  ];
  const bull2Score = Math.round((bull2Checks.filter((x) => x.passed).length / bull2Checks.length) * 100);
  const bull2Extreme = Math.min(b.low, c.low, d.low);
  const bull2Dist = round(Math.max(0, currentPrice - (bull2Extreme - 1.0)));
  patterns.push({
    id: "BULLISH_TWO_CANDLE_DOMINANCE",
    nameVi: "Mô hình 2 Nến Áp Đảo Tăng (Bullish 2-Candle Dominance)",
    nameEn: "Bullish Two-Candle Body Dominance",
    category: "CANDLESTICK",
    direction: "BULLISH",
    status: bull2Score === 100 ? "ACTIVE" : bull2Score >= 75 ? "FORMING" : "INACTIVE",
    matchScore: bull2Score,
    timeframe: "M15",
    summaryVi: "Hai nến tăng liên tiếp có tổng thân lớn hơn nến giảm mạnh trước đó, báo hiệu lực mua bùng nổ.",
    targetStrategy: "TREND",
    recommendedSide: "BUY",
    entryZone: { price: round(currentPrice), mode: bull2Dist > 10 ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice - Math.min(10, Math.max(6, bull2Dist))),
    structuralStopDistance: bull2Dist,
    tp1Price: round(currentPrice + 10),
    tp2Price: round(currentPrice + 20),
    checks: bull2Checks,
  });

  // 3. ENGULFING (Bullish & Bearish)
  const bullEngulfChecks: DetectedPatternRuleCheck[] = [
    { code: "PREV_BEAR", label: "Nến trước giảm", passed: isBear(c), observed: isBear(c) ? "BEAR" : "BULL", required: "BEAR" },
    { code: "CURR_BULL", label: "Nến hiện tại tăng", passed: isBull(d), observed: isBull(d) ? "BULL" : "BEAR", required: "BULL" },
    { code: "OPEN_COVER", label: "Open bao phủ Close nến trước (±0.1)", passed: d.open <= c.close + ENGULF_TOLERANCE + 1e-9, observed: `${round(d.open)} <= ${round(c.close + ENGULF_TOLERANCE)}`, required: "Open <= PrevClose + 0.1" },
    { code: "CLOSE_COVER", label: "Close bao phủ Open nến trước (±0.1)", passed: d.close + ENGULF_TOLERANCE + 1e-9 >= c.open, observed: `${round(d.close + ENGULF_TOLERANCE)} >= ${round(c.open)}`, required: "Close + 0.1 >= PrevOpen" },
  ];
  const bullEngulfScore = Math.round((bullEngulfChecks.filter((x) => x.passed).length / bullEngulfChecks.length) * 100);
  const bullEngulfDist = round(Math.max(0, currentPrice - (d.low - 1.0)));
  patterns.push({
    id: "BULLISH_ENGULFING",
    nameVi: "Mô hình Nến Nhấn Chìm Tăng (Bullish Engulfing)",
    nameEn: "Bullish Engulfing Pattern",
    category: "CANDLESTICK",
    direction: "BULLISH",
    status: bullEngulfScore === 100 ? "ACTIVE" : bullEngulfScore >= 75 ? "FORMING" : "INACTIVE",
    matchScore: bullEngulfScore,
    timeframe: "M15",
    summaryVi: "Nến tăng hiện tại bao trùm toàn bộ thân nến giảm trước đó (dung sai 0.1 giá), xác nhận lực cầu đảo chiều/tiếp diễn.",
    targetStrategy: "TREND",
    recommendedSide: "BUY",
    entryZone: { price: round(currentPrice), mode: bullEngulfDist > 10 ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice - Math.min(10, Math.max(6, bullEngulfDist))),
    structuralStopDistance: bullEngulfDist,
    tp1Price: round(currentPrice + 10),
    tp2Price: round(currentPrice + 20),
    checks: bullEngulfChecks,
  });

  const bearEngulfChecks: DetectedPatternRuleCheck[] = [
    { code: "PREV_BULL", label: "Nến trước tăng", passed: isBull(c), observed: isBull(c) ? "BULL" : "BEAR", required: "BULL" },
    { code: "CURR_BEAR", label: "Nến hiện tại giảm", passed: isBear(d), observed: isBear(d) ? "BEAR" : "BULL", required: "BEAR" },
    { code: "OPEN_COVER", label: "Open bao phủ Close nến trước (±0.1)", passed: d.open + ENGULF_TOLERANCE + 1e-9 >= c.close, observed: `${round(d.open + ENGULF_TOLERANCE)} >= ${round(c.close)}`, required: "Open + 0.1 >= PrevClose" },
    { code: "CLOSE_COVER", label: "Close bao phủ Open nến trước (±0.1)", passed: d.close <= c.open + ENGULF_TOLERANCE + 1e-9, observed: `${round(d.close)} <= ${round(c.open + ENGULF_TOLERANCE)}`, required: "Close <= PrevOpen + 0.1" },
  ];
  const bearEngulfScore = Math.round((bearEngulfChecks.filter((x) => x.passed).length / bearEngulfChecks.length) * 100);
  const bearEngulfDist = round(Math.max(0, (d.high + 1.0) - currentPrice));
  patterns.push({
    id: "BEARISH_ENGULFING",
    nameVi: "Mô hình Nến Nhấn Chìm Giảm (Bearish Engulfing)",
    nameEn: "Bearish Engulfing Pattern",
    category: "CANDLESTICK",
    direction: "BEARISH",
    status: bearEngulfScore === 100 ? "ACTIVE" : bearEngulfScore >= 75 ? "FORMING" : "INACTIVE",
    matchScore: bearEngulfScore,
    timeframe: "M15",
    summaryVi: "Nến giảm hiện tại nhấn chìm hoàn toàn thân nến tăng trước đó, báo hiệu áp lực xả hàng mạnh.",
    targetStrategy: "TREND",
    recommendedSide: "SELL",
    entryZone: { price: round(currentPrice), mode: bearEngulfDist > 10 ? "WAIT_PULLBACK" : "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice + Math.min(10, Math.max(6, bearEngulfDist))),
    structuralStopDistance: bearEngulfDist,
    tp1Price: round(currentPrice - 10),
    tp2Price: round(currentPrice - 20),
    checks: bearEngulfChecks,
  });

  // 4. CHART STRUCTURE PATTERNS (Trend Continuation BOS+FVG, CHOCH Reversal, Supply-Demand Range)
  const trendUpChecks: DetectedPatternRuleCheck[] = [
    { code: "REGIME_TREND", label: "Regime TRENDING / BREAKOUT", passed: input.regime === "TRENDING" || input.regime === "BREAKOUT", observed: input.regime, required: "TRENDING | BREAKOUT" },
    { code: "MA_STACK_BULL", label: "Cấu trúc MA20 > MA50 & Close > MA20", passed: ma20 > ma50 && currentPrice > ma20, observed: `MA20=${round(ma20)}, MA50=${round(ma50)}`, required: "Close > MA20 > MA50" },
    { code: "ADX_STRENGTH", label: "Động lượng ADX >= 22", passed: (input.adx ?? 0) >= 22, observed: String(round(input.adx ?? 0, 1)), required: ">= 22.0" },
  ];
  const trendUpScore = Math.round((trendUpChecks.filter((x) => x.passed).length / trendUpChecks.length) * 100);
  patterns.push({
    id: "BULLISH_BOS_TREND_CONTINUATION",
    nameVi: "Cấu trúc Phá Vỡ Đỉnh Tăng Tiếp Diễn (Bullish BOS + Trend Channel)",
    nameEn: "Bullish BOS & Trend Continuation",
    category: "CHART_STRUCTURE",
    direction: "BULLISH",
    status: trendUpScore === 100 ? "ACTIVE" : trendUpScore >= 66 ? "FORMING" : "INACTIVE",
    matchScore: trendUpScore,
    timeframe: "M15+M5",
    summaryVi: "Giá tạo đỉnh/đáy cao dần (Higher High - Higher Low), phá vỡ BOS đi kèm cấu trúc MA20 > MA50 hỗ trợ đánh thuận xu hướng.",
    targetStrategy: "TREND",
    recommendedSide: "BUY",
    entryZone: { price: round(currentPrice), mode: "ENTRY_IMMEDIATE" },
    stopLossPrice: round(currentPrice - 8),
    structuralStopDistance: 8,
    tp1Price: round(currentPrice + 10),
    tp2Price: round(currentPrice + 24),
    checks: trendUpChecks,
  });

  const sd = input.supplyDemandRange;
  const nearDemand = Boolean(sd && (currentPrice <= sd.demand.high || sd.position <= 0.30));
  const nearSupply = Boolean(sd && (currentPrice >= sd.supply.low || sd.position >= 0.70));
  const rangeChecks: DetectedPatternRuleCheck[] = [
    { code: "REGIME_RANGING", label: "Regime RANGING (Đi ngang)", passed: input.regime === "RANGING", observed: input.regime, required: "RANGING" },
    { code: "HAS_SD_BOX", label: "Hành lang Supply/Demand <= 10 ATR", passed: Boolean(sd), observed: sd ? `${round(sd.demand.low)} - ${round(sd.supply.high)}` : "NONE", required: "Valid S/D Corridor" },
    { code: "AT_RANGE_EDGE", label: "Giá chạm biên Demand (<=30%) hoặc Supply (>=70%)", passed: nearDemand || nearSupply, observed: sd ? `${Math.round(sd.position * 100)}%` : "N/A", required: "<=30% hoặc >=70%" },
  ];
  const rangeScore = Math.round((rangeChecks.filter((x) => x.passed).length / rangeChecks.length) * 100);
  const rangeSide = nearDemand ? "BUY" : nearSupply ? "SELL" : "WAIT";
  patterns.push({
    id: "SUPPLY_DEMAND_RANGE_BOX",
    nameVi: "Mô hình Hộp Tích Lũy Cung - Cầu (Supply-Demand Range Reversion)",
    nameEn: "Supply-Demand Range Corridor",
    category: "CHART_STRUCTURE",
    direction: nearDemand ? "BULLISH" : nearSupply ? "BEARISH" : "NEUTRAL",
    status: rangeScore === 100 ? "ACTIVE" : rangeScore >= 66 ? "FORMING" : "INACTIVE",
    matchScore: rangeScore,
    timeframe: "M15+M5",
    summaryVi: "Giá dao động trong biên độ hẹp giữa vùng Cầu (Demand) và vùng Cung (Supply), tối ưu cho Bot SIDEWAY mua đáy bán đỉnh.",
    targetStrategy: "SIDEWAY",
    recommendedSide: rangeSide,
    entryZone: rangeSide === "WAIT" ? null : { price: round(currentPrice), mode: "ENTRY_IMMEDIATE" },
    stopLossPrice: rangeSide === "BUY" ? round(currentPrice - 7.5) : rangeSide === "SELL" ? round(currentPrice + 7.5) : null,
    structuralStopDistance: rangeSide === "WAIT" ? null : 7.5,
    tp1Price: rangeSide === "BUY" ? round(currentPrice + 10) : rangeSide === "SELL" ? round(currentPrice - 10) : null,
    tp2Price: sd ? (rangeSide === "BUY" ? round(sd.supply.low) : rangeSide === "SELL" ? round(sd.demand.high) : null) : null,
    checks: rangeChecks,
  });

  const sorted = [...patterns].sort((x, y) => y.matchScore - x.matchScore);
  const activeCandlestickPattern = sorted.find((p) => p.category === "CANDLESTICK" && p.matchScore >= 75) ?? sorted.find((p) => p.category === "CANDLESTICK") ?? null;
  const activeChartStructurePattern = sorted.find((p) => p.category === "CHART_STRUCTURE" && p.matchScore >= 66) ?? sorted.find((p) => p.category === "CHART_STRUCTURE") ?? null;
  const activePrimaryPattern = sorted[0] ?? null;

  const recommendedBotMode: StrategyOptimizationAdvice["recommendedBotMode"] =
    input.recommendedMode === "TREND" || input.recommendedMode === "SIDEWAY" || input.recommendedMode === "PAUSE"
      ? "AUTO"
      : "PAUSE";
  const effectiveTargetStrategy: "TREND" | "SIDEWAY" | "PAUSE" =
    input.recommendedMode === "SIDEWAY"
      ? "SIDEWAY"
      : input.recommendedMode === "TREND"
        ? "TREND"
        : "PAUSE";
  const primarySide = activePrimaryPattern?.recommendedSide ?? "WAIT";
  const slDist = activePrimaryPattern?.structuralStopDistance ?? 8.0;
  const entryExecMode: StrategyOptimizationAdvice["entryExecutionMode"] =
    effectiveTargetStrategy === "PAUSE"
      ? "BLOCKED_WAIT"
      : slDist > 10
        ? "WAIT_PULLBACK"
        : "ENTRY_IMMEDIATE";

  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    symbol: input.symbol,
    timeframe: "M15",
    currentPrice: round(currentPrice),
    activePrimaryPattern,
    activeCandlestickPattern,
    activeChartStructurePattern,
    patterns: sorted,
    strategyAdvice: {
      currentBotMode: input.activeMode,
      recommendedBotMode,
      modeChangeNeeded: input.activeMode !== recommendedBotMode && input.activeMode !== effectiveTargetStrategy,
      recommendedStrategy: effectiveTargetStrategy,
      recommendedSide: primarySide,
      entryExecutionMode: entryExecMode,
      headlineVi:
        effectiveTargetStrategy === "TREND"
          ? `Khuyến nghị ưu tiên chiến lược TREND (${primarySide}) — Phát hiện ${activePrimaryPattern?.nameVi ?? "tín hiệu xu hướng"} (${activePrimaryPattern?.matchScore ?? 0}%)`
          : effectiveTargetStrategy === "SIDEWAY"
            ? `Khuyến nghị ưu tiên chiến lược SIDEWAY (${primarySide}) — Giá đang vận động trong ${activeChartStructurePattern?.nameVi ?? "hành lang Cung - Cầu"}`
            : "Khuyến nghị giữ chế độ PAUSE / Đứng ngoài — Cấu trúc thị trường chưa đồng thuận",
      rationaleVi: [
        `Trạng thái thị trường M15 hiện tại: ${input.regime} (Độ tin cậy ${round(input.regimeConfidence, 1)}%, ATR = ${round(input.atr, 2)}).`,
        activeCandlestickPattern
          ? `Mô hình nến M15 nổi bật nhất: ${activeCandlestickPattern.nameVi} (Độ khớp ${activeCandlestickPattern.matchScore}%).`
          : "Chưa xuất hiện mô hình nến M15 đạt chuẩn.",
        slDist > 10
          ? `Khoảng cách SL cấu trúc hiện tại là ${round(slDist, 2)} giá (> 10.0 giá) -> Bắt buộc kích hoạt WAIT_PULLBACK (chờ hồi M5 tối đa 15 phút, không vào lệnh đuổi).`
          : `Khoảng cách SL cấu trúc nằm trong ngưỡng an toàn (${round(Math.max(6, slDist), 2)} giá) -> Cho phép ENTRY_IMMEDIATE khi đủ điều kiện đồng thuận.`,
      ],
      recommendedConditions: {
        trend: {
          patternM15: true,
          supertrendM15: input.regime !== "REVERSAL",
          supertrendM5: input.regime !== "REVERSAL",
          validTrendStructure: true,
          ma20Ma50: (input.adx ?? 0) < 25,
          fvg: false,
        },
        sideway: {
          rangingRegime: true,
          recommendedModeSideway: true,
          minimumRegimeConfidence: true,
          supplyDemandRange: true,
          rangeEdge: true,
          m5Confirmation: true,
        },
      },
      riskPlan: {
        recommendedLot: 0.12,
        initialSlPrice: activePrimaryPattern?.stopLossPrice ?? null,
        slDistancePrice: round(Math.min(10, Math.max(6, slDist))),
        breakEvenTriggerPrice: primarySide === "BUY" ? round(currentPrice + 6) : primarySide === "SELL" ? round(currentPrice - 6) : null,
        partialCloseTriggerPrice: primarySide === "BUY" ? round(currentPrice + 10) : primarySide === "SELL" ? round(currentPrice - 10) : null,
        partialCloseLot: 0.04,
        runnerLot: 0.08,
        takeProfitPrice: activePrimaryPattern?.tp2Price ?? null,
      },
    },
  };
}

export async function getPhase7CPatternAdvisorSnapshot(symbol = "XAUUSD"): Promise<Phase7CPatternAdvisorSnapshot> {
  const [candlePayload, regimePayload] = await Promise.all([
    getPhase7CM15Candles(symbol, 320),
    getPhase7CLiveRegime(symbol, 320),
  ]);
  const activeMode = phase7CBotModeService.get().mode;
  return analyzeCandlesAndRecommendStrategy({
    symbol: candlePayload.symbol,
    candles: candlePayload.candles,
    regime: regimePayload.regime,
    regimeConfidence: regimePayload.confidence,
    recommendedMode: regimePayload.recommendedMode,
    activeMode,
    atr: Number(regimePayload.metrics?.atr ?? 6.5),
    adx: typeof regimePayload.metrics?.adx === "number" ? regimePayload.metrics.adx : 24,
    supplyDemandRange: regimePayload.supplyDemandRange,
    reversal: regimePayload.reversal
      ? {
          direction: String(regimePayload.reversal.direction),
          side: regimePayload.reversal.side as "BUY" | "SELL",
          timestamp: Number(regimePayload.reversal.timestamp),
          level: Number(regimePayload.reversal.level ?? 0),
        }
      : null,
  });
}
