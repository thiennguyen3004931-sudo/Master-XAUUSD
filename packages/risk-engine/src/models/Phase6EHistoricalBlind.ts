import type { Phase6ADiagnosticMetrics } from "./Phase6ADiagnostics";
import type {
  Phase6Config,
  Phase6Side,
  Phase6TradeResult,
} from "./Phase6TrendEngulfing";

export type Phase6EHistoricalBlindStatus =
  | "INSUFFICIENT_SAMPLE"
  | "PASS"
  | "FAIL";

export interface Phase6EManagementMetrics {
  filledTrades: number;
  reachedPlus6: number;
  reachedPlus10: number;
  breakEvenApplied: number;
  trailingActivated: number;
}

export interface Phase6EExcursion {
  id: string;
  side: Phase6Side;
  signalTimestamp: number;
  entryTime: number;
  exitTime: number | null;
  entry: number;
  stopLoss: number;
  initialRiskUsd: number;
  initialRiskPrice: number;
  maxFavorablePrice: number;
  maxAdversePrice: number;
  mfePrice: number;
  maePrice: number;
  mfeR: number;
  maeR: number;
  distanceToPlus6: number;
  reachedPlus6: boolean;
  reachedPlus10: boolean;
  breakEvenApplied: boolean;
  trailingActivated: boolean;
  exitReason: Phase6TradeResult["exitReason"];
  pnl: number;
  rMultiple: number;
}

export interface Phase6EHistoricalBlindFold {
  fold: number;
  startTimestamp: number;
  endTimestamp: number;
  metrics: Phase6ADiagnosticMetrics;
  sideMetrics: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  positive: boolean;
  buyPositive: boolean;
  sellPositive: boolean;
}

export interface Phase6EExcursionSummary {
  filledTrades: number;
  averageMfePrice: number;
  averageMaePrice: number;
  averageMfeR: number;
  averageMaeR: number;
  medianMfeR: number;
  medianMaeR: number;
  plus6MissesWithin1Price: number;
}

export interface Phase6EHistoricalBlindResult {
  candidate: "BASELINE_BUY_SELL";
  config: Phase6Config;
  blindStartTimestamp: number;
  blindEndTimestamp: number;
  minimumFilledTrades: number;
  minimumProfitFactor: number;
  minimumPositiveFolds: number;
  foldCount: number;
  totalInputCases: number;
  eligibleCases: number;
  eligibleBuyCases: number;
  eligibleSellCases: number;
  metrics: Phase6ADiagnosticMetrics;
  sideMetrics: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  management: Phase6EManagementMetrics;
  sideManagement: Record<Phase6Side, Phase6EManagementMetrics>;
  folds: Phase6EHistoricalBlindFold[];
  positiveFolds: number;
  buyPositiveFolds: number;
  sellPositiveFolds: number;
  excursions: Phase6EExcursion[];
  excursionSummary: Phase6EExcursionSummary;
  eligibleTrades: Phase6TradeResult[];
  status: Phase6EHistoricalBlindStatus;
}
