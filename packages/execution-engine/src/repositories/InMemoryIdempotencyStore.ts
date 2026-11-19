import type { IClock, IIdempotencyStore } from "../contracts";
import type { IdempotencyEntry } from "../models";
import { SystemClock } from "../utils";

export class InMemoryIdempotencyStore
  implements IIdempotencyStore
{
  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(private readonly clock: IClock = new SystemClock()) {}

  async acquire(key: string, expiresAt: number): Promise<boolean> {
    this.deleteExpired();
    if (this.entries.has(key)) return false;

    this.entries.set(key, {
      key,
      state: "RESERVED",
      expiresAt,
    });
    return true;
  }

  async complete(
    key: string,
    recordId: string,
    expiresAt: number,
  ): Promise<void> {
    this.entries.set(key, {
      key,
      state: "COMPLETED",
      recordId,
      expiresAt,
    });
  }

  async get(key: string): Promise<IdempotencyEntry | null> {
    this.deleteExpired();
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : null;
  }

  async release(key: string): Promise<void> {
    this.entries.delete(key);
  }

  private deleteExpired(): void {
    const now = this.clock.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
