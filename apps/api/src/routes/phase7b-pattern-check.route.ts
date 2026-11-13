import { Router, type Request, type Response } from "express";

type Side = "BUY" | "SELL";
type M15Bar = {
  openTime?: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type Check = {
  key: string;
  label: string;
  pass: boolean;
  actual: string;
  rule: string;
  difference?: number;
};

const router = Router();
const ENGULF_BODY_TOLERANCE_PRICE = 0.1;

router.get("/", async (_req: Request, res: Response) => {
  try {
    const bars = await readM15();
    res.json(buildPatternCheck(bars));
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Phase 7B M15 pattern check failed.",
    });
  }
});

async function readM15(): Promise<M15Bar[]> {
  const baseUrl = process.env.MT5_BRIDGE_BASE_URL?.trim().replace(/\/$/, "") ?? "";
  const apiKey = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!baseUrl || !apiKey) throw new Error("MT5 Bridge read-only credentials are unavailable.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${baseUrl}/v1/candles/XAUUSD?timeframe=M15&count=320`, {
      headers: { "x-mt5-api-key": apiKey },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Bridge M15 request failed ${response.status}: ${text}`);
    const bars = JSON.parse(text) as M15Bar[];
    if (!Array.isArray(bars) || bars.length < 201) throw new Error(`Need at least 201 closed M15 bars, received ${bars.length}.`);
    return bars;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPatternCheck(bars: M15Bar[]) {
  const i = bars.length - 1;
  const current = bars[i]!;
  const previous = bars[i - 1]!;
  const prior = bars[i - 2]!;
  const closes = bars.slice(0, i + 1).map((bar) => bar.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);

  const buyEngulfChecks: Check[] = [
    check("prev-bear", "Nến trước giảm", isBearish(previous), color(previous), "Previous = bearish"),
    check("curr-bull", "Nến hiện tại tăng", isBullish(current), color(current), "Current = bullish"),
    check(
      "buy-open-boundary",
      "Open phủ mép Close nến trước",
      current.open <= previous.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9,
      `${fmt(current.open)} <= ${fmt(previous.close)} + ${fmt(ENGULF_BODY_TOLERANCE_PRICE)}`,
      "Current Open <= Previous Close + tolerance",
      round(current.open - previous.close, 5),
    ),
    check(
      "buy-close-boundary",
      "Close phủ mép Open nến trước",
      current.close + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.open,
      `${fmt(current.close)} + ${fmt(ENGULF_BODY_TOLERANCE_PRICE)} >= ${fmt(previous.open)}`,
      "Current Close + tolerance >= Previous Open",
      round(previous.open - current.close, 5),
    ),
  ];

  const sellEngulfChecks: Check[] = [
    check("prev-bull", "Nến trước tăng", isBullish(previous), color(previous), "Previous = bullish"),
    check("curr-bear", "Nến hiện tại giảm", isBearish(current), color(current), "Current = bearish"),
    check(
      "sell-open-boundary",
      "Open phủ mép Close nến trước",
      current.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9 >= previous.close,
      `${fmt(current.open)} + ${fmt(ENGULF_BODY_TOLERANCE_PRICE)} >= ${fmt(previous.close)}`,
      "Current Open + tolerance >= Previous Close",
      round(previous.close - current.open, 5),
    ),
    check(
      "sell-close-boundary",
      "Close phủ mép Open nến trước",
      current.close <= previous.open + ENGULF_BODY_TOLERANCE_PRICE + 1e-9,
      `${fmt(current.close)} <= ${fmt(previous.open)} + ${fmt(ENGULF_BODY_TOLERANCE_PRICE)}`,
      "Current Close <= Previous Open + tolerance",
      round(current.close - previous.open, 5),
    ),
  ];

  const priorBody = body(prior);
  const firstBody = body(previous);
  const secondBody = body(current);
  const combinedBody = firstBody + secondBody;

  const buyTwoChecks: Check[] = [
    check("a-bear", "A khác màu: giảm", isBearish(prior), color(prior), "A = bearish"),
    check("b-bull", "B cùng màu thứ nhất: tăng", isBullish(previous), color(previous), "B = bullish"),
    check("c-bull", "C cùng màu thứ hai: tăng", isBullish(current), color(current), "C = bullish"),
    check("b-smaller-a", "Thân B nhỏ hơn thân A", firstBody < priorBody, `${fmt(firstBody)} < ${fmt(priorBody)}`, "Body(B) < Body(A)", round(priorBody - firstBody, 5)),
    check("bc-greater-a", "Tổng thân B + C lớn hơn A", combinedBody > priorBody, `${fmt(combinedBody)} > ${fmt(priorBody)}`, "Body(B)+Body(C) > Body(A)", round(combinedBody - priorBody, 5)),
  ];

  const sellTwoChecks: Check[] = [
    check("a-bull", "A khác màu: tăng", isBullish(prior), color(prior), "A = bullish"),
    check("b-bear", "B cùng màu thứ nhất: giảm", isBearish(previous), color(previous), "B = bearish"),
    check("c-bear", "C cùng màu thứ hai: giảm", isBearish(current), color(current), "C = bearish"),
    check("b-smaller-a", "Thân B nhỏ hơn thân A", firstBody < priorBody, `${fmt(firstBody)} < ${fmt(priorBody)}`, "Body(B) < Body(A)", round(priorBody - firstBody, 5)),
    check("bc-greater-a", "Tổng thân B + C lớn hơn A", combinedBody > priorBody, `${fmt(combinedBody)} > ${fmt(priorBody)}`, "Body(B)+Body(C) > Body(A)", round(combinedBody - priorBody, 5)),
  ];

  const buyEngulf = buyEngulfChecks.every((item) => item.pass);
  const sellEngulf = sellEngulfChecks.every((item) => item.pass);
  const buyTwo = buyTwoChecks.every((item) => item.pass);
  const sellTwo = sellTwoChecks.every((item) => item.pass);
  const buyPattern = buyEngulf || buyTwo;
  const sellPattern = sellEngulf || sellTwo;

  const buyTrendChecks: Check[] = [
    check("ma20-ma50", "MA20 > MA50", ma20 > ma50, `${fmt(ma20)} > ${fmt(ma50)}`, "MA20 > MA50"),
    check("ma50-ma200", "MA50 > MA200", ma50 > ma200, `${fmt(ma50)} > ${fmt(ma200)}`, "MA50 > MA200"),
    check("close-ma20", "Close > MA20", current.close > ma20, `${fmt(current.close)} > ${fmt(ma20)}`, "Close > MA20"),
  ];
  const sellTrendChecks: Check[] = [
    check("ma20-ma50", "MA20 < MA50", ma20 < ma50, `${fmt(ma20)} < ${fmt(ma50)}`, "MA20 < MA50"),
    check("ma50-ma200", "MA50 < MA200", ma50 < ma200, `${fmt(ma50)} < ${fmt(ma200)}`, "MA50 < MA200"),
    check("close-ma20", "Close < MA20", current.close < ma20, `${fmt(current.close)} < ${fmt(ma20)}`, "Close < MA20"),
  ];
  const buyTrend = buyTrendChecks.every((item) => item.pass);
  const sellTrend = sellTrendChecks.every((item) => item.pass);

  const buyFvg = hasRelevantFvg(bars, i, "BUY", 12);
  const sellFvg = hasRelevantFvg(bars, i, "SELL", 12);
  const buyEligible = buyPattern && buyTrend;
  const sellEligible = sellPattern && sellTrend;

  return {
    readOnly: true,
    generatedAt: Date.now(),
    symbol: "XAUUSD",
    timeframe: "M15",
    closeTime: current.closeTime,
    nextCloseTime: current.closeTime + 15 * 60_000,
    rules: {
      entry: "PATTERN_PLUS_MA",
      engulfBodyTolerancePrice: ENGULF_BODY_TOLERANCE_PRICE,
      fvgRequiredForEntry: false,
      twoCandle: "BODY_B_LT_BODY_A_AND_BODY_B_PLUS_BODY_C_GT_BODY_A",
    },
    candles: {
      A: candle(prior),
      B: candle(previous),
      C: candle(current),
    },
    ma: { ma20: round(ma20, 5), ma50: round(ma50, 5), ma200: round(ma200, 5) },
    buy: {
      eligible: buyEligible,
      pattern: buyEngulf ? "ENGULFING" : buyTwo ? "TWO_CANDLE_BODY_DOMINANCE" : null,
      engulfing: { pass: buyEngulf, checks: buyEngulfChecks },
      twoCandle: { pass: buyTwo, checks: buyTwoChecks },
      trend: { pass: buyTrend, checks: buyTrendChecks },
      fvgConfirmed: buyFvg,
      reason: finalReason("BUY", buyPattern, buyTrend, buyFvg),
    },
    sell: {
      eligible: sellEligible,
      pattern: sellEngulf ? "ENGULFING" : sellTwo ? "TWO_CANDLE_BODY_DOMINANCE" : null,
      engulfing: { pass: sellEngulf, checks: sellEngulfChecks },
      twoCandle: { pass: sellTwo, checks: sellTwoChecks },
      trend: { pass: sellTrend, checks: sellTrendChecks },
      fvgConfirmed: sellFvg,
      reason: finalReason("SELL", sellPattern, sellTrend, sellFvg),
    },
  };
}

function finalReason(side: Side, pattern: boolean, trend: boolean, fvg: boolean): string {
  if (!pattern) return `${side}: chưa đạt Engulfing (tolerance 0,10 giá) hoặc mẫu 2 nến.`;
  if (!trend) return `${side}: Pattern đạt nhưng MA20/50/200 chưa đồng thuận.`;
  return fvg
    ? `${side}: ĐỦ Pattern + MA; FVG cùng hướng xác nhận thêm.`
    : `${side}: ĐỦ Pattern + MA; FVG chưa có nhưng không chặn entry.`;
}

function check(key: string, label: string, pass: boolean, actual: string, rule: string, difference?: number): Check {
  return { key, label, pass, actual, rule, ...(difference === undefined ? {} : { difference }) };
}

function candle(bar: M15Bar) {
  return {
    closeTime: bar.closeTime,
    open: round(bar.open, 5),
    high: round(bar.high, 5),
    low: round(bar.low, 5),
    close: round(bar.close, 5),
    body: round(body(bar), 5),
    color: color(bar),
  };
}

function hasRelevantFvg(bars: M15Bar[], index: number, side: Side, lookback: number): boolean {
  const start = Math.max(2, index - lookback);
  const current = bars[index]!;
  for (let i = index - 1; i >= start; i -= 1) {
    const first = bars[i - 2]!;
    const third = bars[i]!;
    if (side === "BUY" && third.low > first.high && current.low <= third.low && current.high >= first.high) return true;
    if (side === "SELL" && third.high < first.low && current.high >= third.high && current.low <= first.low) return true;
  }
  return false;
}

function sma(values: number[], period: number): number {
  if (values.length < period) throw new Error(`Not enough M15 bars for MA${period}.`);
  return values.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}
function isBullish(bar: M15Bar): boolean { return bar.close > bar.open; }
function isBearish(bar: M15Bar): boolean { return bar.close < bar.open; }
function body(bar: M15Bar): number { return Math.abs(bar.close - bar.open); }
function color(bar: M15Bar): "BULL" | "BEAR" | "DOJI" { return isBullish(bar) ? "BULL" : isBearish(bar) ? "BEAR" : "DOJI"; }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round((value + Number.EPSILON) * factor) / factor; }
function fmt(value: number): string { return round(value, 5).toFixed(2); }

export default router;
