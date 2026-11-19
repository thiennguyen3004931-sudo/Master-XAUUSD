export type Direction = "BUY" | "SELL" | "WAIT";
export type TradingMode = "SHADOW" | "DEMO" | "LIVE_LOCKED";
export type ServiceStatus = "HEALTHY" | "DEGRADED" | "OFFLINE";

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
    direction: Direction;
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
  recentTrades: TradeRow[];
  services: ServiceHealth[];
  control: {
    mode: TradingMode;
    tradingEnabled: boolean;
    liveUnlockAvailable: false;
    updatedAt: number;
  };
}

export interface ServiceHealth {
  id: string;
  name: string;
  status: ServiceStatus;
  latencyMs: number | null;
  message: string;
  checkedAt: number;
}

export interface TradeRow {
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
}

export interface BacktestRunRequest {
  symbol: string;
  timeframe: string;
  from: string;
  to: string;
  initialBalance: number;
  riskPercent: number;
  spread: number;
  slippageTicks: number;
  intrabarPriority: "STOP_FIRST" | "OHLC_PATH";
}

export interface BacktestResultDto {
  runId: string;
  source: "PACK10";
  generatedAt: number;
  metrics: {
    netReturnPercent: number;
    netProfit: number;
    totalTrades: number;
    winRatePercent: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    averageRMultiple: number;
  };
  equityCurve: Array<{ timestamp: number; balance: number; equity: number }>;
  drawdownCurve: Array<{ timestamp: number; drawdownPercent: number }>;
  warnings: string[];
}

export interface Mt5TelemetryHealth {
  status: "ok" | "degraded";
  connected: boolean;
  tradingEnabled: boolean;
  terminalTradeAllowed: boolean;
  expertTradeAllowed: boolean;
  accountLogin?: number;
  accountMode?: "demo" | "contest" | "real";
  accountCurrency?: string;
  accountBalance?: number;
  accountEquity?: number;
  accountFreeMargin?: number;
  accountProfit?: number;
  server?: string;
  terminalVersion?: string;
  lastError?: string | null;
  timestamp: number;
}

export interface Mt5TelemetryQuote {
  symbol: string;
  brokerSymbol: string;
  bid: number;
  ask: number;
  spread: number;
  timestamp: number;
}

export interface Mt5TelemetrySpec {
  symbol: string;
  brokerSymbol: string;
  tickSize: number;
  digits: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  maxSpread: number;
  stopsLevelTicks: number;
  freezeLevelTicks: number;
  fillingMode: number;
  executionMode: number;
}

export interface Mt5TelemetryPosition {
  ticket: string;
  symbol: string;
  brokerSymbol: string;
  side: "LONG" | "SHORT";
  volume: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  swap: number;
  commission: number;
  openedAt?: number;
}

export interface Mt5TelemetrySnapshot {
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  status: ServiceStatus;
  message: string;
  latencyMs: number | null;
  bridgeBaseUrl: string;
  accountLogin: number | null;
  health: Mt5TelemetryHealth | null;
  quote: Mt5TelemetryQuote | null;
  spec: Mt5TelemetrySpec | null;
  positions: Mt5TelemetryPosition[];
  checkedAt: number;
}

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
    equityCurve: Array<{
      timestamp: number;
      balance: number;
      drawdownPercent: number;
    }>;
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
