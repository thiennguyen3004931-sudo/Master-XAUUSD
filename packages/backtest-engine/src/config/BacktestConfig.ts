export type EntryFillMode =
  | "NEXT_BAR_OPEN"
  | "PLANNED_PRICE_TOUCH";

export type IntrabarPriority =
  | "STOP_FIRST"
  | "TARGET_FIRST"
  | "OHLC_PATH";

export interface BacktestConfig {
  initialBalance: number;
  contractSize: number;
  tickSize: number;
  priceDigits: number;
  volumeStep: number;
  minVolume: number;
  fallbackSpread: number;
  warmupBars: number;
  evaluateEveryBars: number;
  maxConcurrentPositions: number;
  entryFillMode: EntryFillMode;
  intrabarPriority: IntrabarPriority;
  allowSameBarExit: boolean;
  forceCloseAtEnd: boolean;
  breakEvenOffsetTicks: number;
  trailingAtrPeriod: number;
  annualTradingDays: number;
  riskFreeRateAnnual: number;
}
