import type { AiAuditRecord } from "../models";

export interface IAiAuditRepository {
  save(record: AiAuditRecord): Promise<void>;
  findById(id: string): Promise<AiAuditRecord | null>;
  list(limit?: number): Promise<AiAuditRecord[]>;
}
