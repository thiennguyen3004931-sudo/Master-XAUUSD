import type { Account } from "@xauusd/types";
import { defaultMt5BrokerConfig } from "@xauusd/mt5-broker";
import type { DashboardSnapshot } from "../types/dashboard";

type TradeRow = DashboardSnapshot["recentTrades"][number];
import {
getMt5AllPositions,
  getMt5DealHistory,
  getMt5TradingDayBoundary,
} from "./mt5-market.service";
import {
  updateMt5RiskState,
  type Mt5EquitySample,
} from "./mt5-risk-state.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = 14 * 365 * DAY_MS;

export interface Mt5RiskHistorySnapshot {
  dailyRealizedPnl: number;
  peakEquity: number;
  observedPeakEquity: number;
  realizedBalancePeak: number;
  consecutiveLosses: number;
  dayStart: number;
  rolloverUtcHour: number;
  riskDayBoundarySource: "MT5_D1_CURRENT_BAR";
  balanceReconciliationError: number;
  equityCurve: Mt5EquitySample[];
  recentTrades: TradeRow[];
  dealCount: number;
}


interface RecentTradeBuildOptions {
  systemOwnedOnly?: boolean;
  systemMagic?: number;
}

function dealMagic(deal: unknown): number | null {
  if (typeof deal !== "object" || deal === null) return null;

  const value = (deal as { magic?: unknown }).magic;

  return typeof value === "number" && Number.isInteger(value)
    ? value
    : null;
}

function dealComment(deal: unknown): string {
  if (typeof deal !== "object" || deal === null) return "";

  const value = (deal as { comment?: unknown }).comment;

  return typeof value === "string" ? value : "";
}

function isValidationTradeComment(comment: string): boolean {
  const normalized = comment.toLowerCase();

  return (
    normalized.includes("gate2") ||
    normalized.includes("gate3")
  );
}

function resolveSystemTradeMagic(): number {
  const configured = Number(
    process.env.MT5_MAGIC_NUMBER ??
      defaultMt5BrokerConfig.magicNumber,
  );

  if (!Number.isInteger(configured) || configured <= 0) {
    throw new Error("MT5 system trade magic is invalid.");
  }

  return configured;
}

function createRecentTrades(
  deals: Awaited<ReturnType<typeof getMt5DealHistory>>,
  options: RecentTradeBuildOptions = {},
): TradeRow[] {
  const groups = new Map<
    string,
    Awaited<ReturnType<typeof getMt5DealHistory>>
  >();

  for (const deal of deals) {
    if (
      !deal.isTradingDeal ||
      !deal.positionId ||
      deal.positionId === "0"
    ) {
      continue;
    }

    const group = groups.get(deal.positionId) ?? [];
    group.push(deal);
    groups.set(deal.positionId, group);
  }

  const trades: TradeRow[] = [];

  for (const [positionId, group] of groups) {
    group.sort((left, right) => left.timestamp - right.timestamp);

    const opens = group.filter(
      (deal) => deal.entry === "IN" && deal.side !== null,
    );
    const closes = group.filter(
      (deal) =>
        deal.entry === "OUT" ||
        deal.entry === "OUT_BY" ||
        deal.entry === "INOUT",
    );

    const firstOpen = opens.at(0);
    const lastClose = closes.at(-1);

    if (!firstOpen || !lastClose || firstOpen.side === null) {
      continue;
    }

    if (options.systemOwnedOnly) {
      if (
        !Number.isInteger(options.systemMagic) ||
        (options.systemMagic ?? 0) <= 0
      ) {
        throw new Error(
          "System-owned trade reconstruction requires a valid system magic.",
        );
      }

      const openingMagic = dealMagic(firstOpen);
      const openingComment = dealComment(firstOpen);

      if (
        openingMagic !== options.systemMagic ||
        isValidationTradeComment(openingComment)
      ) {
        continue;
      }
    }

    const openVolume = opens.reduce(
      (sum, deal) => sum + deal.volume,
      0,
    );
    const closeVolume = closes.reduce(
      (sum, deal) => sum + deal.volume,
      0,
    );

    if (openVolume <= 0 || closeVolume <= 0) {
      continue;
    }

    const entry = opens.reduce(
      (sum, deal) => sum + deal.price * deal.volume,
      0,
    ) / openVolume;

    const exit = closes.reduce(
      (sum, deal) => sum + deal.price * deal.volume,
      0,
    ) / closeVolume;

    const pnl = group.reduce(
      (sum, deal) => sum + deal.netPnl,
      0,
    );

    trades.push({
      id: `mt5-${positionId}`,
      openedAt: firstOpen.timestamp,
      closedAt: lastClose.timestamp,
      side: firstOpen.side,
      symbol: firstOpen.symbol || "XAUUSD",
      volume: openVolume,
      entry,
      exit,
      pnl,
      status: "CLOSED",
    });
  }

  return trades
    .sort(
      (left, right) =>
        (right.closedAt ?? 0) - (left.closedAt ?? 0),
    )
    .slice(0, 20);
}

function countConsecutiveLosses(trades: TradeRow[]): number {
  let count = 0;

  for (const trade of trades) {
    if (trade.pnl < 0) {
      count += 1;
      continue;
    }
    break;
  }

  return count;
}

export async function getMt5RiskHistorySnapshot(
  account: Account,
  now: number,
): Promise<Mt5RiskHistorySnapshot> {
  const positions = await getMt5AllPositions();

  // Phase 3D.2: broker positions are now supported by the live
  // portfolio/open-risk pipeline. Realized deal history remains
  // valid while positions are open, so do not fail on position count.

  const historyStart = Math.max(0, now - HISTORY_WINDOW_MS);
  const deals = await getMt5DealHistory(historyStart, now);
  const boundary = await getMt5TradingDayBoundary("XAUUSD");
  const dayStart = boundary.currentStartTime;

  if (
    !Number.isFinite(dayStart) ||
    dayStart <= 0 ||
    dayStart > now ||
    now - dayStart > 5 * DAY_MS
  ) {
    throw new Error(
      "MT5 broker trading-day boundary failed validation.",
    );
  }

  const hour = new Date(dayStart).getUTCHours();

  const tradingDeals = deals.filter((deal) => deal.isTradingDeal);

  const dailyRealizedPnl = tradingDeals
    .filter((deal) => deal.timestamp >= dayStart)
    .reduce((sum, deal) => sum + deal.netPnl, 0);

  const totalCashFlow = deals.reduce(
    (sum, deal) => sum + deal.netPnl,
    0,
  );

  let reconstructedBalance = account.balance - totalCashFlow;
  let realizedBalancePeak = reconstructedBalance;

  for (const deal of deals) {
    reconstructedBalance += deal.netPnl;
    realizedBalancePeak = Math.max(
      realizedBalancePeak,
      reconstructedBalance,
    );
  }

  const reconciliationError = Math.abs(
    reconstructedBalance - account.balance,
  );

  if (reconciliationError > 1.0) {
    throw new Error(
      `MT5 balance history does not reconcile: error ${reconciliationError.toFixed(2)} ${account.currency}.`,
    );
  }

  const state = await updateMt5RiskState(
    account.balance,
    account.equity,
    now,
  );

  // Account-wide history remains intact for dashboard visibility and
  // account-level daily loss / balance / drawdown protections.
  const recentTrades = createRecentTrades(tradingDeals);

  // Consecutive-loss strategy protection is ownership-scoped:
  // only positions opened by this system's configured MT5 magic count.
  // Manual, external-EA and validation/gate trades cannot lock the
  // autonomous strategy loss-streak circuit breaker.
  const systemTradeMagic = resolveSystemTradeMagic();
  const systemOwnedRecentTrades = createRecentTrades(tradingDeals, {
    systemOwnedOnly: true,
    systemMagic: systemTradeMagic,
  });

  return {
    dailyRealizedPnl,
    peakEquity: Math.max(
      account.equity,
      realizedBalancePeak,
      state.peakObservedEquity,
    ),
    observedPeakEquity: state.peakObservedEquity,
    realizedBalancePeak,
    consecutiveLosses: countConsecutiveLosses(systemOwnedRecentTrades),
    dayStart,
    rolloverUtcHour: hour,
    riskDayBoundarySource: "MT5_D1_CURRENT_BAR",
    balanceReconciliationError: reconciliationError,
    equityCurve: state.samples,
    recentTrades,
    dealCount: deals.length,
  };
}



