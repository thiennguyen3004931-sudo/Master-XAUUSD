import type { AiCacheEntry, AiDecision } from "../models";

export interface IAiCache {
  get(key: string): Promise<AiCacheEntry | null>;
  set(
    key: string,
    decision: AiDecision,
    expiresAt: number
  ): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
