import type { AiProviderKind } from "./AiProviderKind";
import type { AiStructuredOpinion } from "./AiStructuredOpinion";
import type { AiUsage } from "./AiUsage";

export interface AiOpinion extends AiStructuredOpinion {
  providerId: string;
  providerKind: AiProviderKind;
  model: string;
  requestId: string;
  usage?: AiUsage;
  latencyMs: number;
  receivedAt: number;
}
