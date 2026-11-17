import type { BacktestConfig } from "./BacktestConfig";

export const defaultBacktestConfig: BacktestConfig = {
  initialBalance: 10_000,
  contractSize: 100,
  tickSize: 0.01,
  priceDigits: 2,
  volumeStep: 0.01,
  minVolume: 0.01,
  fallbackSpread: 0.1,
  warmupBars: 200,
  evaluateEveryBars: 1,
  maxConcurrentPositions: 1,
  entryFillMode: "NEXT_BAR_OPEN",
  intrabarPriority: "STOP_FIRST",
  allowSameBarExit: false,
  forceCloseAtEnd: true,
  breakEvenOffsetTicks: 1,
  trailingAtrPeriod: 14,
  annualTradingDays: 252,
  riskFreeRateAnnual: 0,
};
