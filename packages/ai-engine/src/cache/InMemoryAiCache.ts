import type { IAiCache, IClock } from "../contracts";
import type {
  AiCacheEntry,
  AiDecision
} from "../models";
import { SystemClock } from "../utils";

export class InMemoryAiCache implements IAiCache {
  private readonly entries =
    new Map<string, AiCacheEntry>();

  constructor(
    private readonly clock: IClock = new SystemClock()
  ) {}

  async get(key: string): Promise<AiCacheEntry | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return null;
    }

    return structuredClone(entry);
  }

  async set(
    key: string,
    decision: AiDecision,
    expiresAt: number
  ): Promise<void> {
    this.entries.set(key, {
      key,
      decision: structuredClone(decision),
      expiresAt
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
