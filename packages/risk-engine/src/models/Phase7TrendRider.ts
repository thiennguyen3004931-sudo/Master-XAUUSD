export type Phase7Side = "BUY" | "SELL";

export interface Phase7Bar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Phase7RunRequest {
  m15Bars: readonly Phase7Bar[];
  m5Bars: readonly Phase7Bar[];
  fixedVolume: number;
  tickSize: number;
  tickValuePerLot: number;
  minVolume?: number;
  volumeStep?: number;
}

export interface Phase7Config {
  fvgLookbackBars: number;
  entryExpiryMinutes: number;
  minStopDistancePrice: number;
  maxStopDistancePrice: number;
  partial1TriggerPrice: number;
  partial1Fraction: number;
  protectedProfitOffsetPrice: number;
  partial2TriggerPrice: number;
  partial2Fraction: number;
  trailingDistancePrice: number;
}

export interface Phase7Signal {
  id: string;
  side: Phase7Side;
  signalTimestamp: number;
  entry: number;
  engulfingExtreme: number;
  structuralStopDistance: number;
  stopDistance: number;
  stopLoss: number;
  volume: number;
  initialRiskUsd: number;
  ma20: number;
  ma50: number;
  ma200: number;
  fvg: boolean;
}

export interface Phase7TradeResult extends Phase7Signal {
  filled: boolean;
  entryTime: number | null;
  exitTime: number | null;
  exit: number | null;
  finalStopLoss: number;
  pnl: number;
  rMultiple: number;
  holdHours: number;
  partial1Applied: boolean;
  partial1Volume: number;
  partial1Pnl: number;
  protectedStopApplied: boolean;
  partial2Applied: boolean;
  partial2Volume: number;
  partial2Pnl: number;
  trailingActivated: boolean;
  remainingVolumeAtExit: number;
  exitReason: "ENTRY_NOT_FILLED" | "STOP" | "TREND_MA20" | "END_OF_DATA";
}

export interface Phase7Metrics {
  m15Bars: number;
  engulfingTriggers: number;
  trendAligned: number;
  fvgConfirmed: number;
  stopFlooredToMin: number;
  stopCappedToMax: number;
  signals: number;
  buySignals: number;
  sellSignals: number;
  filledTrades: number;
  unfilledTrades: number;
  wins: number;
  losses: number;
  flat: number;
  winRatePercent: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  averageRMultiple: number;
  maxRealizedDrawdownUsd: number;
  averageHoldHours: number;
  partial1Applied: number;
  protectedStopApplied: number;
  partial2Applied: number;
  trailingActivated: number;
}

export interface Phase7RunResult {
  config: Phase7Config;
  metrics: Phase7Metrics;
  signals: Phase7Signal[];
  trades: Phase7TradeResult[];
}
