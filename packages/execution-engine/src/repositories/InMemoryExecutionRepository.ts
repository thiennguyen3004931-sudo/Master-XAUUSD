import type { IExecutionRepository } from "../contracts";
import type { ExecutionRecord } from "../models";

export class InMemoryExecutionRepository
  implements IExecutionRepository
{
  private readonly records = new Map<string, ExecutionRecord>();

  async save(record: ExecutionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async update(record: ExecutionRecord): Promise<void> {
    if (!this.records.has(record.id)) {
      throw new Error(`Execution record ${record.id} does not exist.`);
    }
    this.records.set(record.id, structuredClone(record));
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<ExecutionRecord | null> {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === key) {
        return structuredClone(record);
      }
    }
    return null;
  }

  async findByTicket(
    ticket: string,
  ): Promise<ExecutionRecord | null> {
    for (const record of this.records.values()) {
      if (record.receipt?.ticket === ticket) {
        return structuredClone(record);
      }
    }
    return null;
  }

  async listOpen(): Promise<ExecutionRecord[]> {
    return [...this.records.values()]
      .filter((record) =>
        ["FILLED", "PARTIALLY_FILLED"].includes(record.status),
      )
      .map((record) => structuredClone(record));
  }

  async countCreatedSince(timestamp: number): Promise<number> {
    return [...this.records.values()].filter(
      (record) => record.createdAt >= timestamp,
    ).length;
  }

  async listAll(): Promise<ExecutionRecord[]> {
    return [...this.records.values()].map((record) =>
      structuredClone(record),
    );
  }
}
