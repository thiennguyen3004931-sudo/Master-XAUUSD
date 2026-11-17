import type { StrategyPlan } from "@xauusd/strategy-engine";
import type { ExecutionQuote } from "./ExecutionQuote";
import type { NormalizedExecutionOrder } from "./NormalizedExecutionOrder";
import type { SlippageAssessment } from "./SlippageAssessment";
import type { SymbolExecutionSpec } from "./SymbolExecutionSpec";

export interface ExecutionPreflightDraft {
  adapterConnected: boolean;
  plan: StrategyPlan | null;
  quote: ExecutionQuote | null;
  spec: SymbolExecutionSpec | null;
  normalizedOrder: NormalizedExecutionOrder | null;
  slippage: SlippageAssessment | null;
  duplicate: boolean;
  recentExecutionCount: number;
  evaluatedAt: number;
}
