import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExecutionRecord,
  IExecutionRepository,
} from "@xauusd/execution-engine";

interface RecordJsonRow {
  record_json: string;
}

interface CountRow {
  count: number;
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return structuredClone(record);
}

function serializeRecord(record: ExecutionRecord): string {
  return JSON.stringify(record);
}

function parseRecord(row: RecordJsonRow | undefined): ExecutionRecord | null {
  if (!row) return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(row.record_json);
  } catch (error) {
    throw new Error(
      `Persisted execution record contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { idempotencyKey?: unknown }).idempotencyKey !== "string" ||
    typeof (parsed as { status?: unknown }).status !== "string" ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== "number" ||
    typeof (parsed as { updatedAt?: unknown }).updatedAt !== "number"
  ) {
    throw new Error("Persisted execution record failed structural validation.");
  }

  return cloneRecord(parsed as ExecutionRecord);
}

export class SqliteExecutionRepository
  implements IExecutionRepository
{
  private readonly database: DatabaseSync;

  constructor(private readonly databasePath: string) {
    const normalized = databasePath.trim();

    if (!normalized) {
      throw new Error("Execution state database path cannot be blank.");
    }

    mkdirSync(dirname(normalized), { recursive: true });

    this.database = new DatabaseSync(normalized);

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS execution_records (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        ticket TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_execution_records_ticket
        ON execution_records(ticket);

      CREATE INDEX IF NOT EXISTS idx_execution_records_status
        ON execution_records(status);

      CREATE INDEX IF NOT EXISTS idx_execution_records_created_at
        ON execution_records(created_at);
    `);
  }

  async save(record: ExecutionRecord): Promise<void> {
    const statement = this.database.prepare(`
      INSERT INTO execution_records (
        id,
        idempotency_key,
        ticket,
        status,
        created_at,
        updated_at,
        record_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        ticket = excluded.ticket,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `);

    statement.run(
      record.id,
      record.idempotencyKey,
      record.receipt?.ticket ?? null,
      record.status,
      record.createdAt,
      record.updatedAt,
      serializeRecord(record),
    );
  }

  async update(record: ExecutionRecord): Promise<void> {
    const existing = await this.findById(record.id);

    if (!existing) {
      throw new Error(`Execution record ${record.id} does not exist.`);
    }

    const statement = this.database.prepare(`
      UPDATE execution_records
      SET
        idempotency_key = ?,
        ticket = ?,
        status = ?,
        created_at = ?,
        updated_at = ?,
        record_json = ?
      WHERE id = ?
    `);

    const result = statement.run(
      record.idempotencyKey,
      record.receipt?.ticket ?? null,
      record.status,
      record.createdAt,
      record.updatedAt,
      serializeRecord(record),
      record.id,
    );

    if (Number(result.changes) !== 1) {
      throw new Error(`Execution record ${record.id} update was not durable.`);
    }
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    const row = this.database
      .prepare(`
        SELECT record_json
        FROM execution_records
        WHERE id = ?
        LIMIT 1
      `)
      .get(id) as RecordJsonRow | undefined;

    return parseRecord(row);
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<ExecutionRecord | null> {
    const row = this.database
      .prepare(`
        SELECT record_json
        FROM execution_records
        WHERE idempotency_key = ?
        LIMIT 1
      `)
      .get(key) as RecordJsonRow | undefined;

    return parseRecord(row);
  }

  async findByTicket(
    ticket: string,
  ): Promise<ExecutionRecord | null> {
    const row = this.database
      .prepare(`
        SELECT record_json
        FROM execution_records
        WHERE ticket = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(ticket) as RecordJsonRow | undefined;

    return parseRecord(row);
  }

  async listOpen(): Promise<ExecutionRecord[]> {
    const rows = this.database
      .prepare(`
        SELECT record_json
        FROM execution_records
        WHERE status IN ('FILLED', 'PARTIALLY_FILLED')
        ORDER BY created_at ASC, id ASC
      `)
      .all() as unknown as RecordJsonRow[];

    return rows.map((row) => {
      const record = parseRecord(row);

      if (!record) {
        throw new Error("Open execution record unexpectedly missing.");
      }

      return record;
    });
  }

  async countCreatedSince(timestamp: number): Promise<number> {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("Execution count timestamp must be finite.");
    }

    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM execution_records
        WHERE created_at >= ?
      `)
      .get(timestamp) as CountRow | undefined;

    return Number(row?.count ?? 0);
  }

  async listAll(): Promise<ExecutionRecord[]> {
    const rows = this.database
      .prepare(`
        SELECT record_json
        FROM execution_records
        ORDER BY created_at ASC, id ASC
      `)
      .all() as unknown as RecordJsonRow[];

    return rows.map((row) => {
      const record = parseRecord(row);

      if (!record) {
        throw new Error("Persisted execution record unexpectedly missing.");
      }

      return record;
    });
  }

  close(): void {
    this.database.close();
  }
}