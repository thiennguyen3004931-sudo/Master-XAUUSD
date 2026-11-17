export type Phase6Side = "BUY" | "SELL";

export interface Phase6Bar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Phase6RunRequest {
  m15Bars: readonly Phase6Bar[];
  m5Bars: readonly Phase6Bar[];
  riskCapUsd: number;
  tickSize: number;
  tickValuePerLot: number;
  minVolume?: number;
  volumeStep?: number;
}

export interface Phase6Config {
  minConfluenceScore: number;
  atrPeriod: number;
  maPullbackAtrTolerance: number;
  fvgLookbackBars: number;
  profileLookbackBars: number;
  profileBins: number;
  profileValueAreaFraction: number;
  entryExpiryMinutes: number;
  breakEvenTriggerPrice: number;
  breakEvenOffsetPrice: number;
  trailingTriggerPrice: number;
  trailingDistancePrice: number;
}

export interface Phase6VolumeProfile {
  poc: number;
  vah: number;
  val: number;
}

export interface Phase6Signal {
  id: string;
  side: Phase6Side;
  signalTimestamp: number;
  entry: number;
  stopLoss: number;
  volume: number;
  initialRiskUsd: number;
  ma20: number;
  ma50: number;
  ma200: number;
  atr: number;
  confluenceScore: number;
  maPullback: boolean;
  fvg: boolean;
  volumeProfile: boolean;
  profile: Phase6VolumeProfile | null;
}

export interface Phase6TradeResult extends Phase6Signal {
  filled: boolean;
  entryTime: number | null;
  exitTime: number | null;
  exit: number | null;
  finalStopLoss: number;
  pnl: number;
  rMultiple: number;
  holdHours: number;
  reachedPlus6: boolean;
  reachedPlus10: boolean;
  breakEvenApplied: boolean;
  trailingActivated: boolean;
  exitReason: "ENTRY_NOT_FILLED" | "STOP" | "TREND_MA20" | "END_OF_DATA";
}

export interface Phase6Metrics {
  m15Bars: number;
  engulfingTriggers: number;
  trendAligned: number;
  confluencePassed: number;
  riskBlocked: number;
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
  reachedPlus6: number;
  reachedPlus10: number;
  breakEvenApplied: number;
  trailingActivated: number;
}

export interface Phase6RunResult {
  config: Phase6Config;
  metrics: Phase6Metrics;
  signals: Phase6Signal[];
  trades: Phase6TradeResult[];
}
