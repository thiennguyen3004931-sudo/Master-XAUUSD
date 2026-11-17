type Deal = {
  ticket: string;
  positionId: string;
  symbol: string;
  side: "BUY" | "SELL" | null;
  entry: "IN" | "OUT" | "INOUT" | "OUT_BY" | "UNKNOWN";
  volume: number;
  price: number;
  netPnl: number;
  magic: number;
  comment: string;
  timestamp: number;
  isTradingDeal: boolean;
};

type Health = {
  connected: boolean;
  accountMode: "demo" | "contest" | "real" | null;
  accountLogin: number | null;
  server: string | null;
  accountCurrency: string | null;
};

type Trade = {
  id: string;
  side: "BUY" | "SELL";
  openedAt: number;
  closedAt: number;
  volume: number;
  entry: number;
  exit: number;
  netPnl: number;
};

function baseUrl(): string {
  return (process.env.MT5_BRIDGE_BASE_URL ?? "http://127.0.0.1:8765").trim().replace(/\/$/, "");
}

function apiKey(): string {
  const value = process.env.MT5_BRIDGE_API_KEY?.trim() ?? "";
  if (!value) throw new Error("MT5_BRIDGE_API_KEY is not configured.");
  return value;
}

async function read<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      headers: { "x-mt5-api-key": apiKey() },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MT5 bridge ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPhase7CForwardRange(from: string, to: string) {
  const fromMs = Date.parse(from);
  const toStartMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStartMs)) throw new Error("Invalid from/to date.");
  const toMs = toStartMs + 24 * 60 * 60_000;
  if (fromMs >= toMs) throw new Error("from must be before to.");
  if (toMs - fromMs > 370 * 24 * 60 * 60_000) throw new Error("Forward comparison supports up to 370 days.");

  const [health, deals] = await Promise.all([
    read<Health>("/health"),
    read<Deal[]>(`/v1/history/deals?fromMs=${fromMs}&toMs=${toMs}&symbol=XAUUSD`),
  ]);
  if (!health.connected || health.accountMode !== "demo") throw new Error("Forward comparison requires connected DEMO MT5.");

  const magic = Number(process.env.MT5_MAGIC_NUMBER ?? 270713);
  const groups = new Map<string, Deal[]>();
  for (const deal of deals) {
    if (!deal.isTradingDeal || !deal.positionId || deal.positionId === "0") continue;
    const group = groups.get(deal.positionId) ?? [];
    group.push(deal);
    groups.set(deal.positionId, group);
  }

  const trades: Trade[] = [];
  for (const [positionId, group] of groups) {
    group.sort((a, b) => a.timestamp - b.timestamp);
    const opens = group.filter((deal) => deal.entry === "IN" && deal.side !== null);
    const closes = group.filter((deal) => deal.entry === "OUT" || deal.entry === "OUT_BY" || deal.entry === "INOUT");
    const firstOpen = opens.at(0);
    const lastClose = closes.at(-1);
    if (!firstOpen || !lastClose || firstOpen.side === null) continue;
    if (firstOpen.magic !== magic) continue;
    const openVolume = opens.reduce((sum, deal) => sum + deal.volume, 0);
    const closeVolume = closes.reduce((sum, deal) => sum + deal.volume, 0);
    if (openVolume <= 0 || closeVolume + 1e-8 < openVolume) continue;
    const entry = opens.reduce((sum, deal) => sum + deal.price * deal.volume, 0) / openVolume;
    const exit = closes.reduce((sum, deal) => sum + deal.price * deal.volume, 0) / closeVolume;
    trades.push({
      id: `mt5-${positionId}`,
      side: firstOpen.side,
      openedAt: firstOpen.timestamp,
      closedAt: lastClose.timestamp,
      volume: round(openVolume, 2),
      entry: round(entry, 2),
      exit: round(exit, 2),
      netPnl: round(group.reduce((sum, deal) => sum + deal.netPnl, 0), 2),
    });
  }

  trades.sort((a, b) => b.closedAt - a.closedAt);
  const metrics = summarize(trades);
  return {
    source: "MT5_DEMO_SYSTEM_DEALS_EXACT_RANGE",
    generatedAt: Date.now(),
    range: { from, to },
    account: { login: health.accountLogin, server: health.server, currency: health.accountCurrency ?? "USD" },
    magic,
    metrics,
    trades: trades.slice(0, 250),
    note: "SYSTEM-only uses configured MT5 magic. This endpoint is read-only and does not mutate Phase 7B.",
  };
}

function summarize(trades: Trade[]) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: round(trades.length ? wins.length / trades.length * 100 : 0, 2),
    netPnl: round(netPnl, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    expectancy: round(trades.length ? netPnl / trades.length : 0, 2),
  };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
