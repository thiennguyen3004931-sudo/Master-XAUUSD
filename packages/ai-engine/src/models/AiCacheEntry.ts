import type { AiDecision } from "./AiDecision";

export interface AiCacheEntry {
  key: string;
  decision: AiDecision;
  expiresAt: number;
}
