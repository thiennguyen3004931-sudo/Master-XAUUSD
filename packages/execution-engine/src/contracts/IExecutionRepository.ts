import type { ExecutionRecord } from "../models";

export interface IExecutionRepository {
  save(record: ExecutionRecord): Promise<void>;
  update(record: ExecutionRecord): Promise<void>;
  findById(id: string): Promise<ExecutionRecord | null>;
  findByIdempotencyKey(key: string): Promise<ExecutionRecord | null>;
  findByTicket(ticket: string): Promise<ExecutionRecord | null>;
  listOpen(): Promise<ExecutionRecord[]>;
  countCreatedSince(timestamp: number): Promise<number>;
  listAll(): Promise<ExecutionRecord[]>;
}
