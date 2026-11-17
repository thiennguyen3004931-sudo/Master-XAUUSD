import type { AiAction } from "./AiAction";
import type { AiFeatureContribution } from "./AiFeatureContribution";

export interface AiStructuredOpinion {
  schemaVersion: string;
  action: AiAction;
  confidence: number;
  marketQualityScore: number;
  executionQualityScore: number;
  riskQualityScore: number;
  reasons: string[];
  warnings: string[];
  invalidationConditions: string[];
  featureContributions: AiFeatureContribution[];
}
