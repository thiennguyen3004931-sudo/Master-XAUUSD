import type { Signal, TradeDecision } from "@xauusd/types";
import type { SignalDiagnostics } from "./SignalDiagnostics";
import type { SignalLevelPlan } from "./SignalLevelPlan";
import type { SignalRuleResult } from "./SignalRuleResult";
import type { SignalScore } from "./SignalScore";

export interface SignalEngineResult {
  decision: TradeDecision;
  signal: Signal | null;
  score: SignalScore;
  levels: SignalLevelPlan | null;
  rules: SignalRuleResult[];
  diagnostics: SignalDiagnostics;
  generatedAt: number;
}
