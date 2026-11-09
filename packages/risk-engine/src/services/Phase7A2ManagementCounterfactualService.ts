import type { Phase7RunRequest, Phase7RunResult, Phase7Side, Phase7TradeResult } from "../models";

type Variant = "CURRENT" | "FULL_HOLD" | "PARTIAL_6_ONLY" | "PARTIAL_10_ONLY";

interface VariantTrade {
  side: Phase7Side;
  filled: boolean;
  pnl: number;
  rMultiple: number;
}

interface VariantSummary {
  filled: number;
  winRatePercent: number;
  netPnl: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number;
}

export interface Phase7A2ManagementCounterfactualResult {
  lines: string[];
}

export class Phase7A2ManagementCounterfactualService {
  analyze(result: Phase7RunResult, request: Phase7RunRequest): Phase7A2ManagementCounterfactualResult {
    const variants: Record<Variant, VariantTrade[]> = {
      CURRENT: [],
      FULL_HOLD: [],
      PARTIAL_6_ONLY: [],
      PARTIAL_10_ONLY: [],
    };

    for (const trade of result.trades) {
      for (const variant of Object.keys(variants) as Variant[]) {
        const pnl = variantPnl(trade, variant, request);
        variants[variant].push({
          side: trade.side,
          filled: trade.filled,
          pnl,
          rMultiple: trade.initialRiskUsd > 0 ? pnl / trade.initialRiskUsd : 0,
        });
      }
    }

    const lines: string[] = [
      "PHASE7A2_MODE=MANAGEMENT_COUNTERFACTUAL_ONLY",
      "PHASE7A2_SAME_ENTRY_SL_EXIT_PATH=PASS",
      "PHASE7A2_ENTRY_FILTER_MUTATION=false",
      "PHASE7A2_STOP_MUTATION=false",
      "PHASE7A2_TRAILING_PATH_MUTATION=false",
    ];

    for (const scope of ["ALL", "BUY", "SELL"] as const) {
      for (const variant of Object.keys(variants) as Variant[]) {
        const rows = scope === "ALL"
          ? variants[variant]
          : variants[variant].filter((row) => row.side === scope);
        lines.push(formatVariant(`PHASE7A2_${scope}_${variant}`, rows));
      }

      const current = summary(scopeRows(variants.CURRENT, scope));
      const full = summary(scopeRows(variants.FULL_HOLD, scope));
      const p6 = summary(scopeRows(variants.PARTIAL_6_ONLY, scope));
      const p10 = summary(scopeRows(variants.PARTIAL_10_ONLY, scope));
      lines.push(
        `PHASE7A2_${scope}_DELTA_VS_CURRENT=` +
        `FULL_HOLD:${round(full.netPnl - current.netPnl, 2)}` +
        `|PARTIAL_6_ONLY:${round(p6.netPnl - current.netPnl, 2)}` +
        `|PARTIAL_10_ONLY:${round(p10.netPnl - current.netPnl, 2)}`,
      );
    }

    const plus6Only = result.trades.filter((trade) => trade.protectedStopApplied && !trade.trailingActivated);
    const plus10 = result.trades.filter((trade) => trade.trailingActivated);
    lines.push(formatStage("PHASE7A2_STAGE_PLUS6_ONLY", plus6Only, request));
    lines.push(formatStage("PHASE7A2_STAGE_PLUS10_TRAIL", plus10, request));
    lines.push("PHASE7A2_AUTO_SELECTION=OFF");
    lines.push("PHASE7A2_NO_RETUNE=PASS");
    lines.push("PHASE7A2_RESEARCH_ONLY=PASS");
    lines.push("PHASE7A2_PRODUCTION_MUTATION=false");

    return { lines };
  }
}

function scopeRows(rows: readonly VariantTrade[], scope: "ALL" | "BUY" | "SELL"): VariantTrade[] {
  return scope === "ALL" ? [...rows] : rows.filter((row) => row.side === scope);
}

function variantPnl(trade: Phase7TradeResult, variant: Variant, request: Phase7RunRequest): number {
  if (!trade.filled || trade.exit === null) return 0;
  if (variant === "CURRENT") return trade.pnl;

  const fullExit = pnlUsd(
    trade.side,
    trade.entry,
    trade.exit,
    trade.volume,
    request.tickSize,
    request.tickValuePerLot,
  );
  if (variant === "FULL_HOLD") return fullExit;

  if (variant === "PARTIAL_6_ONLY") {
    const closeVolume = trade.partial1Applied ? trade.partial1Volume : 0;
    const remaining = Math.max(0, trade.volume - closeVolume);
    return trade.partial1Pnl + pnlUsd(
      trade.side,
      trade.entry,
      trade.exit,
      remaining,
      request.tickSize,
      request.tickValuePerLot,
    );
  }

  const closeVolume = trade.partial2Applied ? trade.partial2Volume : 0;
  const remaining = Math.max(0, trade.volume - closeVolume);
  return trade.partial2Pnl + pnlUsd(
    trade.side,
    trade.entry,
    trade.exit,
    remaining,
    request.tickSize,
    request.tickValuePerLot,
  );
}

function formatVariant(name: string, rows: readonly VariantTrade[]): string {
  const s = summary(rows);
  return `${name}=FILLED=${s.filled}|WR=${s.winRatePercent}|NET=${s.netPnl}|PF=${s.profitFactor ?? "INF"}|EXP=${s.expectancy}|AVG_R=${s.averageR}`;
}

function formatStage(name: string, trades: readonly Phase7TradeResult[], request: Phase7RunRequest): string {
  const current = trades.reduce((sum, trade) => sum + variantPnl(trade, "CURRENT", request), 0);
  const full = trades.reduce((sum, trade) => sum + variantPnl(trade, "FULL_HOLD", request), 0);
  const p6 = trades.reduce((sum, trade) => sum + variantPnl(trade, "PARTIAL_6_ONLY", request), 0);
  const p10 = trades.reduce((sum, trade) => sum + variantPnl(trade, "PARTIAL_10_ONLY", request), 0);
  return `${name}=FILLED=${trades.filter((trade) => trade.filled).length}` +
    `|CURRENT=${round(current, 2)}` +
    `|FULL_HOLD=${round(full, 2)}` +
    `|PARTIAL_6_ONLY=${round(p6, 2)}` +
    `|PARTIAL_10_ONLY=${round(p10, 2)}`;
}

function summary(rows: readonly VariantTrade[]): VariantSummary {
  const filled = rows.filter((row) => row.filled);
  const wins = filled.filter((row) => row.pnl > 0);
  const grossProfit = filled.reduce((sum, row) => sum + Math.max(0, row.pnl), 0);
  const grossLoss = Math.abs(filled.reduce((sum, row) => sum + Math.min(0, row.pnl), 0));
  const netPnl = filled.reduce((sum, row) => sum + row.pnl, 0);
  return {
    filled: filled.length,
    winRatePercent: round(filled.length ? wins.length / filled.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : null,
    expectancy: round(filled.length ? netPnl / filled.length : 0, 4),
    averageR: round(filled.length ? filled.reduce((sum, row) => sum + row.rMultiple, 0) / filled.length : 0, 4),
  };
}

function pnlUsd(
  side: Phase7Side,
  entry: number,
  exit: number,
  volume: number,
  tickSize: number,
  tickValuePerLot: number,
): number {
  const move = side === "BUY" ? exit - entry : entry - exit;
  return move / tickSize * tickValuePerLot * volume;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
