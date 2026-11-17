import type { Mt5BridgeDeal } from "@xauusd/mt5-broker";
import { getMt5Telemetry } from "./mt5.service";
import { getPhase7CCanonicalDeals } from "./phase7c-canonical-deal-ledger.service";
import { resolvePhase7CDailyRecoveryMagicNumbers } from "./phase7c-daily-recovery-view.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERFORMANCE_CARRY_IN_DAYS = 365;
const MIN_RECOMMENDATION_SAMPLE = 30;

export interface Mt5PerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  winRatePercent: number;
  profitFactor: number | null;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxConsecutiveLosses: number;
}

export interface Mt5PerformanceTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  ownership: "SYSTEM" | "VALIDATION" | "OTHER";
  strategy: "TREND" | "SIDEWAY" | "OTHER";
  openedAt: number;
  closedAt: number;
  durationMinutes: number;
  volume: number;
  entry: number;
  exit: number;
  netPnl: number;
  session: string;
  brokerHour: number;
  weekday: string;
  exitReason: "UNKNOWN";
}

export interface Mt5PerformanceBucket {
  key: string;
  label: string;
  totalTrades: number;
  netPnl: number;
  winRatePercent: number;
  profitFactor: number | null;
}

export interface Mt5PerformanceRecommendation {
  severity: "INFO" | "WATCH" | "ACTION";
  title: string;
  evidence: string;
  suggestion: string;
  autoApply: false;
}

export interface Mt5PerformanceSnapshot {
  source: "MT5_ACCOUNT_READ_ONLY";
  symbol: string;
  currency: string;
  days: number;
  generatedAt: number;
  account: {
    accountMode: "DEMO" | "LIVE";
    brokerMode: "demo" | "real";
    login: number | null;
    server: string | null;
  };
  safety: {
    accountMode: "DEMO" | "LIVE";
    bridgeTradingEnabled: boolean;
    readOnly: true;
    strategyAutoChange: false;
    liveUnlockAvailable: false;
  };
  accountWide: {
    metrics: Mt5PerformanceMetrics;
    equityCurve: Array<{ timestamp: number; balance: number; drawdownPercent: number }>;
  };
  systemOwned: {
    metrics: Mt5PerformanceMetrics;
    minimumRecommendationSample: number;
    sampleReady: boolean;
    recent20: Mt5PerformanceMetrics | null;
    previous20: Mt5PerformanceMetrics | null;
  };
  trades: Mt5PerformanceTrade[];
  breakdown: {
    strategy: Mt5PerformanceBucket[];
    side: Mt5PerformanceBucket[];
    session: Mt5PerformanceBucket[];
    weekday: Mt5PerformanceBucket[];
    hour: Mt5PerformanceBucket[];
    ownership: Mt5PerformanceBucket[];
  };
  recommendations: Mt5PerformanceRecommendation[];
  notes: string[];
}

const WEEKDAYS = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"] as const;

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function strategyOf(opening: Mt5BridgeDeal, trendMagic: number, sidewayMagic: number): Mt5PerformanceTrade["strategy"] {
  const magic = Number(opening.magic);
  if (magic === sidewayMagic) return "SIDEWAY";
  if (magic === trendMagic) return "TREND";
  const comment = String(opening.comment ?? "").toLowerCase();
  if (comment.includes("phase7c-sideway") || comment.includes("p7c-sideway")) return "SIDEWAY";
  if (comment.includes("phase7b-demo") || comment.includes("p7b-")) return "TREND";
  return "OTHER";
}

function ownershipOf(opening: Mt5BridgeDeal, trendMagic: number, sidewayMagic: number): Mt5PerformanceTrade["ownership"] {
  const comment = String(opening.comment ?? "").toLowerCase();
  if (comment.includes("gate2") || comment.includes("gate3")) return "VALIDATION";
  return strategyOf(opening, trendMagic, sidewayMagic) === "OTHER" ? "OTHER" : "SYSTEM";
}

function strategyOfOpenings(openings: readonly Mt5BridgeDeal[], trendMagic: number, sidewayMagic: number): Mt5PerformanceTrade["strategy"] {
  const strategies = new Set(openings.map((opening) => strategyOf(opening, trendMagic, sidewayMagic)));
  if (strategies.size !== 1) return "OTHER";
  const [strategy] = strategies;
  return strategy ?? "OTHER";
}

function ownershipOfOpenings(openings: readonly Mt5BridgeDeal[], trendMagic: number, sidewayMagic: number): Mt5PerformanceTrade["ownership"] {
  const ownerships = openings.map((opening) => ownershipOf(opening, trendMagic, sidewayMagic));
  if (ownerships.includes("VALIDATION")) return "VALIDATION";
  if (ownerships.every((ownership) => ownership === "SYSTEM") && strategyOfOpenings(openings, trendMagic, sidewayMagic) !== "OTHER") {
    return "SYSTEM";
  }
  return "OTHER";
}

function sessionFromHour(hour: number): string {
  if (hour < 8) return "ASIAN";
  if (hour < 13) return "LONDON";
  if (hour < 17) return "OVERLAP";
  if (hour < 22) return "NEW_YORK";
  return "CLOSED";
}

function reconstructTrades(deals: readonly Mt5BridgeDeal[], trendMagic: number, sidewayMagic: number): Mt5PerformanceTrade[] {
  const groups = new Map<string, Mt5BridgeDeal[]>();
  for (const deal of deals) {
    if (!deal.isTradingDeal || !deal.positionId || deal.positionId === "0") continue;
    const group = groups.get(deal.positionId) ?? [];
    group.push(deal);
    groups.set(deal.positionId, group);
  }

  const EPSILON = 1e-8;
  const trades: Mt5PerformanceTrade[] = [];
  for (const [positionId, group] of groups) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    let nextLegIndex = 0;
    let active: {
      opening: Mt5BridgeDeal;
      openings: Mt5BridgeDeal[];
      side: "BUY" | "SELL";
      legIndex: number;
      openedAt: number;
      openVolume: number;
      remainingVolume: number;
      entryNotional: number;
      closedVolume: number;
      exitNotional: number;
      netPnl: number;
    } | null = null;

    const startLeg = (opening: Mt5BridgeDeal, volume: number, netPnl: number) => {
      if (opening.side === null || volume <= EPSILON) return null;
      return {
        opening,
        openings: [opening],
        side: opening.side,
        legIndex: nextLegIndex++,
        openedAt: opening.timestamp,
        openVolume: volume,
        remainingVolume: volume,
        entryNotional: opening.price * volume,
        closedVolume: 0,
        exitNotional: 0,
        netPnl,
      };
    };

    const finishLeg = (closedAt: number) => {
      if (!active || active.remainingVolume > EPSILON || active.closedVolume <= EPSILON || active.openVolume <= EPSILON) return;
      const hour = new Date(active.openedAt).getUTCHours();
      const day = new Date(active.openedAt).getUTCDay();
      trades.push({
        id: active.legIndex === 0 ? `mt5-${positionId}` : `mt5-${positionId}-r${active.legIndex}`,
        symbol: active.opening.symbol || "XAUUSD",
        side: active.side,
        ownership: ownershipOfOpenings(active.openings, trendMagic, sidewayMagic),
        strategy: strategyOfOpenings(active.openings, trendMagic, sidewayMagic),
        openedAt: active.openedAt,
        closedAt,
        durationMinutes: round(Math.max(0, closedAt - active.openedAt) / 60_000, 1),
        volume: round(active.openVolume, 2),
        entry: round(active.entryNotional / active.openVolume, 2),
        exit: round(active.exitNotional / active.closedVolume, 2),
        netPnl: round(active.netPnl, 2),
        session: sessionFromHour(hour),
        brokerHour: hour,
        weekday: WEEKDAYS[day] ?? String(day),
        exitReason: "UNKNOWN",
      });
      active = null;
    };

    for (const deal of group) {
      if (deal.entry === "IN" && deal.side !== null && deal.volume > EPSILON) {
        if (!active) {
          active = startLeg(deal, deal.volume, deal.netPnl);
        } else if (active.side === deal.side) {
          active.openings.push(deal);
          active.openVolume += deal.volume;
          active.remainingVolume += deal.volume;
          active.entryNotional += deal.price * deal.volume;
          active.netPnl += deal.netPnl;
        }
        continue;
      }

      if (!active || (deal.entry !== "OUT" && deal.entry !== "OUT_BY" && deal.entry !== "INOUT")) continue;
      const closeVolume = Math.min(deal.volume, active.remainingVolume);
      if (closeVolume <= EPSILON) continue;

      active.remainingVolume = Math.max(0, active.remainingVolume - closeVolume);
      active.closedVolume += closeVolume;
      active.exitNotional += deal.price * closeVolume;
      active.netPnl += deal.netPnl;

      const reversalResidual = deal.entry === "INOUT" ? Math.max(0, deal.volume - closeVolume) : 0;
      const reversalOpening = reversalResidual > EPSILON && deal.side !== null ? deal : null;
      if (active.remainingVolume <= EPSILON) {
        finishLeg(deal.timestamp);
        if (reversalOpening) active = startLeg(reversalOpening, reversalResidual, 0);
      }
    }
  }
  return trades.sort((a, b) => b.closedAt - a.closedAt);
}

function calculateMetrics(trades: readonly Mt5PerformanceTrade[], startingBalance?: number): Mt5PerformanceMetrics {
  const chronological = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const wins = chronological.filter((trade) => trade.netPnl > 0);
  const losses = chronological.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = chronological.reduce((sum, trade) => sum + trade.netPnl, 0);

  let streak = 0;
  let maxConsecutiveLosses = 0;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let balance = startingBalance ?? 0;
  let peak = balance;

  for (const trade of chronological) {
    if (trade.netPnl < 0) {
      streak += 1;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, streak);
    } else streak = 0;

    if (startingBalance && startingBalance > 0) {
      balance += trade.netPnl;
      peak = Math.max(peak, balance);
      const drawdown = peak - balance;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? (drawdown / peak) * 100 : 0);
    }
  }

  return {
    totalTrades: chronological.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: chronological.length - wins.length - losses.length,
    netPnl: round(netPnl),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    winRatePercent: chronological.length ? round((wins.length / chronological.length) * 100) : 0,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : grossProfit > 0 ? null : 0,
    expectancy: chronological.length ? round(netPnl / chronological.length) : 0,
    averageWin: wins.length ? round(grossProfit / wins.length) : 0,
    averageLoss: losses.length ? round(grossLoss / losses.length) : 0,
    maxDrawdown: round(maxDrawdown),
    maxDrawdownPercent: round(maxDrawdownPercent),
    maxConsecutiveLosses,
  };
}

function buildEquityCurve(trades: readonly Mt5PerformanceTrade[], startingBalance: number) {
  let balance = startingBalance;
  let peak = startingBalance;
  return [...trades]
    .sort((a, b) => a.closedAt - b.closedAt)
    .map((trade) => {
      balance += trade.netPnl;
      peak = Math.max(peak, balance);
      return {
        timestamp: trade.closedAt,
        balance: round(balance),
        drawdownPercent: round(peak > 0 ? ((peak - balance) / peak) * 100 : 0),
      };
    });
}

function bucket(trades: readonly Mt5PerformanceTrade[], keyOf: (trade: Mt5PerformanceTrade) => string): Mt5PerformanceBucket[] {
  const groups = new Map<string, Mt5PerformanceTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      const metrics = calculateMetrics(rows);
      return { key, label: key, totalTrades: metrics.totalTrades, netPnl: metrics.netPnl, winRatePercent: metrics.winRatePercent, profitFactor: metrics.profitFactor };
    })
    .sort((a, b) => b.totalTrades - a.totalTrades || a.label.localeCompare(b.label));
}

function recommendations(systemTrades: readonly Mt5PerformanceTrade[], accountMode: "DEMO" | "LIVE"): Mt5PerformanceRecommendation[] {
  if (systemTrades.length < MIN_RECOMMENDATION_SAMPLE) {
    return [{
      severity: "INFO",
      title: `Đang thu thập mẫu ${accountMode}`,
      evidence: `Mới có ${systemTrades.length}/${MIN_RECOMMENDATION_SAMPLE} system-owned trade đã đóng trên tài khoản hiện tại.`,
      suggestion: "Tiếp tục thu thập dữ liệu; chưa retune và không tự động thay đổi chiến lược từ trang hiệu suất.",
      autoApply: false,
    }];
  }
  const all = calculateMetrics(systemTrades);
  if ((all.profitFactor ?? 0) < 1 && all.winRatePercent < 40) {
    return [{
      severity: "WATCH",
      title: "Forward sample đang yếu",
      evidence: `PF ${String(all.profitFactor ?? "∞")} · Win rate ${all.winRatePercent.toFixed(1)}% · ${all.totalTrades} trades.`,
      suggestion: "Review riêng chiến lược sau khi đủ mẫu; không tự động thay đổi tham số.",
      autoApply: false,
    }];
  }
  return [{
    severity: "INFO",
    title: "Chưa có lý do thay đổi chiến lược",
    evidence: `${all.totalTrades} system-owned trades chưa kích hoạt cảnh báo review.`,
    suggestion: "Tiếp tục theo dõi; không auto-fit và không tự động đổi chiến lược.",
    autoApply: false,
  }];
}

function resolveAccountMode(mode: unknown): { accountMode: "DEMO" | "LIVE"; brokerMode: "demo" | "real" } {
  if (mode === "demo") return { accountMode: "DEMO", brokerMode: "demo" };
  if (mode === "real") return { accountMode: "LIVE", brokerMode: "real" };
  throw new Error(`MT5 performance analytics supports DEMO or LIVE only. Actual=${String(mode ?? "unknown")}`);
}

export async function getMt5PerformanceSnapshot(days = 90, symbol = "XAUUSD"): Promise<Mt5PerformanceSnapshot> {
  if (!Number.isInteger(days) || days < 7 || days > 365) throw new Error("days must be an integer between 7 and 365.");
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (normalizedSymbol !== "XAUUSD") throw new Error("MT5 performance page currently supports XAUUSD only.");

  const telemetry = await getMt5Telemetry(normalizedSymbol);
  if (!telemetry.reachable || !telemetry.health?.connected) throw new Error(`MT5 telemetry unavailable: ${telemetry.message}`);

  const account = resolveAccountMode(telemetry.health.accountMode);
  const bridgeTradingEnabled = Boolean(telemetry.health.tradingEnabled);
  const brokerNow = telemetry.quote?.timestamp ?? Date.now();
  const fromMs = Math.max(0, brokerNow - days * DAY_MS);
  const historyFromMs = Math.max(0, fromMs - PERFORMANCE_CARRY_IN_DAYS * DAY_MS);
  const deals = (await getPhase7CCanonicalDeals({
    telemetry,
    symbol: normalizedSymbol,
    fromMs: historyFromMs,
    toMs: brokerNow,
  })).filter((deal) => deal.isTradingDeal);

  const resolvedMagicNumbers = resolvePhase7CDailyRecoveryMagicNumbers({
    accountMode: account.accountMode,
  });
  const trendMagic = resolvedMagicNumbers.trendMagicNumber;
  const sidewayMagic = resolvedMagicNumbers.sidewayMagicNumber;
  if (!Number.isInteger(trendMagic) || trendMagic <= 0) throw new Error("Configured Trend magic is invalid.");
  if (!Number.isInteger(sidewayMagic) || sidewayMagic <= 0) throw new Error("Configured Sideway magic is invalid.");
  if (trendMagic === sidewayMagic) throw new Error("Trend and Sideway magic numbers must be distinct.");

  const trades = reconstructTrades(deals, trendMagic, sidewayMagic)
    .filter((trade) => trade.closedAt >= fromMs && trade.closedAt < brokerNow);
  const currentBalance = telemetry.health.accountBalance;
  const accountWindowPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const startingBalance = typeof currentBalance === "number" && Number.isFinite(currentBalance) && currentBalance > 0
    ? Math.max(0.01, currentBalance - accountWindowPnl)
    : 10_000;
  const systemTrades = trades.filter((trade) => trade.ownership === "SYSTEM");
  const systemMetrics = calculateMetrics(systemTrades);

  return {
    source: "MT5_ACCOUNT_READ_ONLY",
    symbol: normalizedSymbol,
    currency: telemetry.health.accountCurrency ?? "USD",
    days,
    generatedAt: brokerNow,
    account: {
      accountMode: account.accountMode,
      brokerMode: account.brokerMode,
      login: telemetry.accountLogin,
      server: telemetry.health.server ?? null,
    },
    safety: {
      accountMode: account.accountMode,
      bridgeTradingEnabled,
      readOnly: true,
      strategyAutoChange: false,
      liveUnlockAvailable: false,
    },
    accountWide: {
      metrics: calculateMetrics(trades, startingBalance),
      equityCurve: buildEquityCurve(trades, startingBalance),
    },
    systemOwned: {
      metrics: systemMetrics,
      minimumRecommendationSample: MIN_RECOMMENDATION_SAMPLE,
      sampleReady: systemTrades.length >= MIN_RECOMMENDATION_SAMPLE,
      recent20: systemTrades.length >= 20 ? calculateMetrics(systemTrades.slice(0, 20)) : null,
      previous20: systemTrades.length >= 40 ? calculateMetrics(systemTrades.slice(20, 40)) : null,
    },
    trades: trades.slice(0, 250),
    breakdown: {
      strategy: (["TREND", "SIDEWAY"] as const).map((strategy) => {
        const metrics = calculateMetrics(systemTrades.filter((trade) => trade.strategy === strategy));
        return { key: strategy, label: strategy, totalTrades: metrics.totalTrades, netPnl: metrics.netPnl, winRatePercent: metrics.winRatePercent, profitFactor: metrics.profitFactor };
      }),
      side: bucket(trades, (trade) => trade.side),
      session: bucket(trades, (trade) => trade.session),
      weekday: bucket(trades, (trade) => trade.weekday),
      hour: bucket(trades, (trade) => `${String(trade.brokerHour).padStart(2, "0")}:00`),
      ownership: bucket(trades, (trade) => trade.ownership),
    },
    recommendations: recommendations(systemTrades, account.accountMode),
    notes: [
      `Đang đọc lịch sử tài khoản ${account.accountMode} hiện tại theo chế độ read-only.`,
      "Account-wide metrics có thể gồm lệnh manual/external/validation.",
      `SYSTEM ownership dùng Trend magic ${trendMagic} và Sideway magic ${sidewayMagic}.`,
      "Trang hiệu suất không đổi strategy, không gửi order và không mutate position.",
    ],
  };
}