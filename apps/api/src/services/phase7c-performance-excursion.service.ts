import type {
  Phase7CPerformanceExcursion,
  Phase7CPerformanceSide,
} from "../contracts/phase7c-performance-effectiveness.schema";

export interface Phase7CExcursionBar {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
}

export interface Phase7CExcursionInput {
  side: Phase7CPerformanceSide;
  entry: number;
  exit: number;
  openedAt: number;
  closedAt: number;
  initialRiskPrice: number | null;
  bars: readonly Phase7CExcursionBar[];
}

function emptyExcursion(evidence: "INCOMPLETE" | "UNAVAILABLE"): Phase7CPerformanceExcursion {
  return {
    evidence,
    initialRiskPrice: null,
    mfePrice: null,
    maePrice: null,
    mfeR: null,
    maeR: null,
    realizedR: null,
    peakToExitGivebackPrice: null,
  };
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function validBar(bar: Phase7CExcursionBar): boolean {
  const openTime = Number(bar.openTime);
  const closeTime = Number(bar.closeTime);
  const high = Number(bar.high);
  const low = Number(bar.low);
  return (
    [openTime, closeTime, high, low].every(Number.isFinite) &&
    closeTime > openTime &&
    high >= low &&
    high > 0 &&
    low > 0
  );
}

export function evaluatePhase7CExcursion(input: Phase7CExcursionInput): Phase7CPerformanceExcursion {
  const side = String(input.side).toUpperCase();
  const entry = Number(input.entry);
  const exit = Number(input.exit);
  const openedAt = Number(input.openedAt);
  const closedAt = Number(input.closedAt);

  if (
    (side !== "BUY" && side !== "SELL") ||
    !(entry > 0) ||
    !(exit > 0) ||
    !Number.isFinite(openedAt) ||
    !Number.isFinite(closedAt) ||
    closedAt < openedAt ||
    !Array.isArray(input.bars) ||
    input.bars.length === 0 ||
    input.bars.some((bar) => !validBar(bar))
  ) {
    return emptyExcursion("UNAVAILABLE");
  }

  const bars = [...input.bars]
    .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime)
    .filter((bar) => bar.closeTime >= openedAt && bar.openTime <= closedAt);
  if (bars.length === 0) return emptyExcursion("INCOMPLETE");

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  if (first.openTime > openedAt || last.closeTime < closedAt) {
    return emptyExcursion("INCOMPLETE");
  }

  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1]!;
    const current = bars[index]!;
    if (current.openTime > previous.closeTime) return emptyExcursion("INCOMPLETE");
  }

  const highest = Math.max(...bars.map((bar) => bar.high));
  const lowest = Math.min(...bars.map((bar) => bar.low));
  const mfePrice = side === "BUY"
    ? Math.max(0, highest - entry)
    : Math.max(0, entry - lowest);
  const maePrice = side === "BUY"
    ? Math.max(0, entry - lowest)
    : Math.max(0, highest - entry);
  const favorableAtExit = side === "BUY"
    ? exit - entry
    : entry - exit;
  const peakToExitGivebackPrice = Math.max(0, mfePrice - favorableAtExit);

  const rawRisk = input.initialRiskPrice === null ? null : Number(input.initialRiskPrice);
  const initialRiskPrice = rawRisk !== null && Number.isFinite(rawRisk) && rawRisk > 0
    ? rawRisk
    : null;
  const realizedPrice = side === "BUY" ? exit - entry : entry - exit;

  return {
    evidence: "COMPLETE_M5_WINDOW",
    initialRiskPrice: initialRiskPrice === null ? null : round(initialRiskPrice),
    mfePrice: round(mfePrice),
    maePrice: round(maePrice),
    mfeR: initialRiskPrice === null ? null : round(mfePrice / initialRiskPrice),
    maeR: initialRiskPrice === null ? null : round(maePrice / initialRiskPrice),
    realizedR: initialRiskPrice === null ? null : round(realizedPrice / initialRiskPrice),
    peakToExitGivebackPrice: round(peakToExitGivebackPrice),
  };
}
