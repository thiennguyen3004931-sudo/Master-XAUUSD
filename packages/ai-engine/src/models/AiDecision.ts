import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import type { AiConsensus } from "./AiConsensus";
import type { AiDiagnostics } from "./AiDiagnostics";
import type { AiFeatureVector } from "./AiFeatureVector";
import type { AiPolicyResult } from "./AiPolicyResult";
import type { AiProviderFailure } from "./AiProviderFailure";

export interface AiDecision {
  executable: boolean;
  originalStrategyEvaluation: StrategyEvaluation;
  features: AiFeatureVector;
  consensus: AiConsensus | null;
  policy: AiPolicyResult;
  providerFailures: AiProviderFailure[];
  diagnostics: AiDiagnostics;
  generatedAt: number;
}
