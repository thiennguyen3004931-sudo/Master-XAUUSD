import type { IdempotencyEntry } from "../models";

export interface IIdempotencyStore {
  acquire(key: string, expiresAt: number): Promise<boolean>;
  complete(key: string, recordId: string, expiresAt: number): Promise<void>;
  get(key: string): Promise<IdempotencyEntry | null>;
  release(key: string): Promise<void>;
}
