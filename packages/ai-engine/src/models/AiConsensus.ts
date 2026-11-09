import type { AiAction } from "./AiAction";
import type { AiOpinion } from "./AiOpinion";

export interface AiConsensus {
  action: AiAction;
  confidence: number;
  agreementRatio: number;
  providerCount: number;
  validOpinionCount: number;
  opinions: AiOpinion[];
  dissentingProviders: string[];
  reasons: string[];
  warnings: string[];
}
