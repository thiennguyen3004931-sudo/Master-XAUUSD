import type { IAiAuditRepository } from "../contracts";
import type { AiAuditRecord } from "../models";

export class InMemoryAiAuditRepository
  implements IAiAuditRepository
{
  private readonly records =
    new Map<string, AiAuditRecord>();

  async save(record: AiAuditRecord): Promise<void> {
    this.records.set(
      record.id,
      structuredClone(record)
    );
  }

  async findById(
    id: string
  ): Promise<AiAuditRecord | null> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(limit = 100): Promise<AiAuditRecord[]> {
    return [...this.records.values()]
      .sort((left, right) =>
        right.createdAt - left.createdAt
      )
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}
