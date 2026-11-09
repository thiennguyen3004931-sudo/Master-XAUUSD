export type DashboardDirection = "BUY" | "SELL" | "WAIT";
export type DashboardTradingMode = "SHADOW" | "DEMO" | "LIVE_LOCKED";
export type DashboardServiceStatus = "HEALTHY" | "DEGRADED" | "OFFLINE";

export interface DashboardSnapshot {
  source: "ENGINE_DEMO" | "UPSTREAM";
  generatedAt: number;
  market: {
    symbol: string;
    timeframe: string;
    bid: number;
    ask: number;
    spread: number;
    open: number;
    high: number;
    low: number;
    changePercent: number;
    atr: number;
    volatility: string;
    session: string;
    timestamp: number;
  };
  analysis: {
    trend: string;
    structure: string;
    score: number;
    dataQuality: number;
    volatilityPercent: number;
  };
  signal: {
    direction: DashboardDirection;
    strength: string;
    confidence: number;
    entry: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    riskReward: number | null;
    reasons: string[];
    rejectionCodes: string[];
  };
  risk: {
    approved: boolean;
    riskPercent: number;
    riskAmount: number;
    positionSize: number;
    dailyLossPercent: number;
    drawdownPercent: number;
    openRiskPercent: number;
    marginUsagePercent: number;
    maxDailyLossPercent: number;
    maxDrawdownPercent: number;
    maxOpenRiskPercent: number;
    rejectionCodes: string[];
  };
  strategy: {
    action: "EXECUTE" | "WAIT" | "REJECT";
    strategyId: string | null;
    confidence: number;
    regime: string;
    regimeConfidence: number;
    rejectionCodes: string[];
  };
  ai: {
    action: "CONFIRM" | "DOWNGRADE_TO_WAIT" | "REJECT";
    executable: boolean;
    confidence: number;
    agreementRatio: number;
    providerCount: number;
    reasons: string[];
    warnings: string[];
  };
  account: {
    id: string;
    broker: string;
    currency: string;
    balance: number;
    equity: number;
    freeMargin: number;
    margin: number;
    floatingPnl: number;
    dailyPnl: number;
    accountType: "DEMO" | "REAL";
  };
  equityCurve: Array<{ timestamp: number; balance: number; equity: number }>;
  recentTrades: Array<{
    id: string;
    openedAt: number;
    closedAt: number | null;
    side: "BUY" | "SELL";
    symbol: string;
    volume: number;
    entry: number;
    exit: number | null;
    pnl: number;
    status: "OPEN" | "CLOSED";
  }>;
  services: Array<{
    id: string;
    name: string;
    status: DashboardServiceStatus;
    latencyMs: number | null;
    message: string;
    checkedAt: number;
  }>;
  control: {
    mode: DashboardTradingMode;
    tradingEnabled: boolean;
    liveUnlockAvailable: false;
    updatedAt: number;
  };
}
