import type { AiDecision } from "./AiDecision";
import type { AiProviderRequest } from "./AiProviderRequest";

export interface AiAuditRecord {
  id: string;
  request: AiProviderRequest;
  decision: AiDecision;
  createdAt: number;
}
