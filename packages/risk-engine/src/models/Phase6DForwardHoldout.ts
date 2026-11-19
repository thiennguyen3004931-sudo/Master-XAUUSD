import type { Phase6ADiagnosticMetrics } from "./Phase6ADiagnostics";
import type {
  Phase6Config,
  Phase6Side,
  Phase6TradeResult,
} from "./Phase6TrendEngulfing";

export type Phase6DForwardHoldoutStatus =
  | "INSUFFICIENT_SAMPLE"
  | "PASS"
  | "FAIL";

export interface Phase6DForwardHoldoutResult {
  realCutoffTimestamp: number;
  cutoffTimestamp: number;
  datasetOffsetMs: number;
  candidate: "BASELINE_BUY_SELL";
  config: Phase6Config;
  minimumFilledTrades: number;
  minimumProfitFactor: number;
  totalInputCases: number;
  preCutoffCasesIgnored: number;
  postCutoffCases: number;
  eligibleCases: number;
  eligibleBuyCases: number;
  eligibleSellCases: number;
  firstEligibleTimestamp: number | null;
  lastEligibleTimestamp: number | null;
  metrics: Phase6ADiagnosticMetrics;
  sideMetrics: Record<Phase6Side, Phase6ADiagnosticMetrics>;
  eligibleTrades: Phase6TradeResult[];
  status: Phase6DForwardHoldoutStatus;
}
