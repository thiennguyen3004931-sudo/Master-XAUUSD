export interface IdempotencyEntry {
  key: string;
  state: "RESERVED" | "COMPLETED";
  recordId?: string;
  expiresAt: number;
}
