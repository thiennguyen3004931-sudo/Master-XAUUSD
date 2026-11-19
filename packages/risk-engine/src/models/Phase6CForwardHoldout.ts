import type {
  Phase6ADiagnosticMetrics,
} from "./Phase6ADiagnostics";
import type {
  Phase6Config,
  Phase6TradeResult,
} from "./Phase6TrendEngulfing";

export type Phase6CForwardHoldoutStatus =
  | "INSUFFICIENT_SAMPLE"
  | "PASS"
  | "FAIL";

export interface Phase6CForwardHoldoutResult {
  realCutoffTimestamp: number;
  cutoffTimestamp: number;
  datasetOffsetMs: number;
  candidate: "BASELINE_BUY";
  config: Phase6Config;
  minimumFilledTrades: number;
  minimumProfitFactor: number;
  totalInputCases: number;
  preCutoffCasesIgnored: number;
  postCutoffCases: number;
  eligibleCases: number;
  firstEligibleTimestamp: number | null;
  lastEligibleTimestamp: number | null;
  metrics: Phase6ADiagnosticMetrics;
  eligibleTrades: Phase6TradeResult[];
  status: Phase6CForwardHoldoutStatus;
}
