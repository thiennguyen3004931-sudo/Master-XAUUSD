import type { AiProviderKind } from "./AiProviderKind";
import type { AiUsage } from "./AiUsage";

export interface AiProviderResponse {
  providerId: string;
  providerKind: AiProviderKind;
  model: string;
  requestId: string;
  content: string;
  usage?: AiUsage;
  latencyMs: number;
  createdAt: number;
}
