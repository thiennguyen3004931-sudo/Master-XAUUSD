export interface Phase7CForwardRangeResult {
  source: "MT5_DEMO_SYSTEM_DEALS_EXACT_RANGE";
  generatedAt: number;
  range: { from: string; to: string };
  account: { login: number | null; server: string | null; currency: string };
  magic: number;
  metrics: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRatePercent: number;
    netPnl: number;
    profitFactor: number | null;
    expectancy: number;
  };
  trades: Array<{
    id: string;
    side: "BUY" | "SELL";
    openedAt: number;
    closedAt: number;
    volume: number;
    entry: number;
    exit: number;
    netPnl: number;
  }>;
  note: string;
}
