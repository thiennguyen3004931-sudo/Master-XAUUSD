import {
  createHash,
} from "node:crypto";

import {
  DatabaseSync,
} from "node:sqlite";

import type {
  ManagementCommand,
  ManagementCommandResult,
  PositionManagementState,
} from "@xauusd/execution-engine";

export type ManagementCommandStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "EXECUTED"
  | "FAILED";

export interface DurablePositionManagementState {
  ticket: string;
  executionRecordId: string;
  state: PositionManagementState;
  lastMarketTimestamp?: number;
  updatedAt: number;
}

export interface DurableManagementCommand {
  commandKey: string;
  executionRecordId: string;
  ticket: string;
  command: ManagementCommand;
  status: ManagementCommandStatus;
  firstSeenAt: number;
  updatedAt: number;
  result?: ManagementCommandResult;
}

export interface IManagementStateRepository {
  findPositionState(
    ticket: string,
  ): Promise<DurablePositionManagementState | null>;

  savePositionState(
    record: DurablePositionManagementState,
  ): Promise<void>;

  prepareCommand(
    executionRecordId: string,
    command: ManagementCommand,
    now: number,
  ): Promise<DurableManagementCommand>;

  findCommand(
    commandKey: string,
  ): Promise<DurableManagementCommand | null>;

  listCommandsByTicket(
    ticket: string,
  ): Promise<DurableManagementCommand[]>;

  listCommandsByStatus(
    status: ManagementCommandStatus,
  ): Promise<DurableManagementCommand[]>;

  claimCommand(
    commandKey: string,
    now: number,
  ): Promise<DurableManagementCommand | null>;

  releaseCommand(
    commandKey: string,
    now: number,
  ): Promise<boolean>;

  markCommandExecuted(
    commandKey: string,
    result: ManagementCommandResult,
  ): Promise<void>;

  markCommandFailed(
    commandKey: string,
    result: ManagementCommandResult,
  ): Promise<void>;
}

interface PositionStateRow {
  ticket: string;
  execution_record_id: string;
  state_json: string;
  last_market_timestamp: number | null;
  updated_at: number;
}

interface CommandRow {
  command_key: string;
  execution_record_id: string;
  ticket: string;
  command_json: string;
  status: string;
  first_seen_at: number;
  updated_at: number;
  result_json: string | null;
}

function finiteNumber(
  value: number | undefined,
): string {
  return value === undefined
    ? "-"
    : Number(value).toFixed(8);
}

function canonicalIntent(
  command: ManagementCommand,
): string {
  if (command.type === "MODIFY_STOP") {
    return [
      command.ticket,
      command.type,
      command.reason,
      finiteNumber(command.stopLoss),
      finiteNumber(command.takeProfit),
    ].join("|");
  }

  if (command.type === "PARTIAL_CLOSE") {
    return [
      command.ticket,
      command.type,
      command.reason,
      command.targetLabel,
      finiteNumber(command.volume),
    ].join("|");
  }

  return [
    command.ticket,
    command.type,
    command.reason,
    finiteNumber(command.volume),
  ].join("|");
}

export function createManagementCommandKey(
  command: ManagementCommand,
): string {
  return createHash("sha256")
    .update(canonicalIntent(command))
    .digest("hex");
}

export function createStableManagementCommand(
  command: ManagementCommand,
): ManagementCommand {
  const key = createManagementCommandKey(command);

  return {
    ...command,
    commandId: `mgmt-${key.slice(0, 32)}`,
  };
}

function parseState(
  row: PositionStateRow | undefined,
): DurablePositionManagementState | null {
  if (!row) {
    return null;
  }

  const state = JSON.parse(
    row.state_json,
  ) as PositionManagementState;

  return {
    ticket: row.ticket,
    executionRecordId:
      row.execution_record_id,
    state,
    lastMarketTimestamp:
      row.last_market_timestamp ??
      undefined,
    updatedAt: row.updated_at,
  };
}

function parseCommand(
  row: CommandRow | undefined,
): DurableManagementCommand | null {
  if (!row) {
    return null;
  }

  if (
    ![
      "PENDING",
      "IN_FLIGHT",
      "EXECUTED",
      "FAILED",
    ].includes(row.status)
  ) {
    throw new Error(
      `Invalid durable management command status: ${row.status}`,
    );
  }

  return {
    commandKey: row.command_key,
    executionRecordId:
      row.execution_record_id,
    ticket: row.ticket,
    command: JSON.parse(
      row.command_json,
    ) as ManagementCommand,
    status:
      row.status as ManagementCommandStatus,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
    result: row.result_json
      ? JSON.parse(
          row.result_json,
        ) as ManagementCommandResult
      : undefined,
  };
}

export class SqliteManagementStateRepository
  implements IManagementStateRepository
{
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const normalized = databasePath.trim();

    if (!normalized) {
      throw new Error(
        "Management state database path cannot be blank.",
      );
    }

    this.database =
      new DatabaseSync(normalized);

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS management_position_state (
        ticket TEXT PRIMARY KEY,
        execution_record_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        last_market_timestamp INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_management_position_state_execution_record
        ON management_position_state(execution_record_id);

      CREATE TABLE IF NOT EXISTS management_command_ledger (
        command_key TEXT PRIMARY KEY,
        execution_record_id TEXT NOT NULL,
        ticket TEXT NOT NULL,
        command_json TEXT NOT NULL,
        status TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_management_command_ledger_ticket
        ON management_command_ledger(ticket);

      CREATE INDEX IF NOT EXISTS idx_management_command_ledger_status
        ON management_command_ledger(status);
    `);
  }

  async findPositionState(
    ticket: string,
  ): Promise<DurablePositionManagementState | null> {
    const row = this.database
      .prepare(`
        SELECT
          ticket,
          execution_record_id,
          state_json,
          last_market_timestamp,
          updated_at
        FROM management_position_state
        WHERE ticket = ?
      `)
      .get(ticket) as
        | PositionStateRow
        | undefined;

    return parseState(row);
  }

  async savePositionState(
    record: DurablePositionManagementState,
  ): Promise<void> {
    this.database
      .prepare(`
        INSERT INTO management_position_state (
          ticket,
          execution_record_id,
          state_json,
          last_market_timestamp,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ticket) DO UPDATE SET
          execution_record_id = excluded.execution_record_id,
          state_json = excluded.state_json,
          last_market_timestamp = excluded.last_market_timestamp,
          updated_at = excluded.updated_at
      `)
      .run(
        record.ticket,
        record.executionRecordId,
        JSON.stringify(record.state),
        record.lastMarketTimestamp ?? null,
        record.updatedAt,
      );
  }

  async prepareCommand(
    executionRecordId: string,
    command: ManagementCommand,
    now: number,
  ): Promise<DurableManagementCommand> {
    const stable =
      createStableManagementCommand(command);

    const commandKey =
      createManagementCommandKey(stable);

    const existing =
      await this.findCommand(commandKey);

    if (!existing) {
      this.database
        .prepare(`
          INSERT INTO management_command_ledger (
            command_key,
            execution_record_id,
            ticket,
            command_json,
            status,
            first_seen_at,
            updated_at,
            result_json
          )
          VALUES (?, ?, ?, ?, 'PENDING', ?, ?, NULL)
        `)
        .run(
          commandKey,
          executionRecordId,
          stable.ticket,
          JSON.stringify(stable),
          now,
          now,
        );
    }
    else {
      if (
        existing.executionRecordId !==
          executionRecordId ||
        existing.ticket !== stable.ticket
      ) {
        throw new Error(
          "Management command key ownership mismatch.",
        );
      }

      if (
        existing.status === "PENDING" &&
        stable.expiresAt >
          existing.command.expiresAt
      ) {
        this.database
          .prepare(`
            UPDATE management_command_ledger
            SET
              command_json = ?,
              updated_at = ?
            WHERE
              command_key = ? AND
              status = 'PENDING'
          `)
          .run(
            JSON.stringify(stable),
            now,
            commandKey,
          );
      }
    }

    const prepared =
      await this.findCommand(commandKey);

    if (!prepared) {
      throw new Error(
        "Prepared management command was not persisted.",
      );
    }

    return prepared;
  }

  async findCommand(
    commandKey: string,
  ): Promise<DurableManagementCommand | null> {
    const row = this.database
      .prepare(`
        SELECT
          command_key,
          execution_record_id,
          ticket,
          command_json,
          status,
          first_seen_at,
          updated_at,
          result_json
        FROM management_command_ledger
        WHERE command_key = ?
      `)
      .get(commandKey) as
        | CommandRow
        | undefined;

    return parseCommand(row);
  }

  async listCommandsByTicket(
    ticket: string,
  ): Promise<DurableManagementCommand[]> {
    const rows = this.database
      .prepare(`
        SELECT
          command_key,
          execution_record_id,
          ticket,
          command_json,
          status,
          first_seen_at,
          updated_at,
          result_json
        FROM management_command_ledger
        WHERE ticket = ?
        ORDER BY first_seen_at ASC, command_key ASC
      `)
      .all(ticket) as unknown as CommandRow[];

    return rows.map(
      (row) => parseCommand(row)!,
    );
  }

  async listCommandsByStatus(
    status: ManagementCommandStatus,
  ): Promise<DurableManagementCommand[]> {
    const rows = this.database
      .prepare(`
        SELECT
          command_key,
          execution_record_id,
          ticket,
          command_json,
          status,
          first_seen_at,
          updated_at,
          result_json
        FROM management_command_ledger
        WHERE status = ?
        ORDER BY first_seen_at ASC, command_key ASC
      `)
      .all(status) as unknown as CommandRow[];

    return rows.map(
      (row) => parseCommand(row)!,
    );
  }

  async claimCommand(
    commandKey: string,
    now: number,
  ): Promise<DurableManagementCommand | null> {
    const current =
      await this.findCommand(commandKey);

    if (
      !current ||
      current.status !== "PENDING" ||
      current.command.expiresAt <= now
    ) {
      return null;
    }

    const outcome = this.database
      .prepare(`
        UPDATE management_command_ledger
        SET
          status = 'IN_FLIGHT',
          updated_at = ?
        WHERE
          command_key = ? AND
          status = 'PENDING'
      `)
      .run(
        now,
        commandKey,
      );

    if (Number(outcome.changes) !== 1) {
      return null;
    }

    return this.findCommand(commandKey);
  }

  async releaseCommand(
    commandKey: string,
    now: number,
  ): Promise<boolean> {
    const outcome = this.database
      .prepare(`
        UPDATE management_command_ledger
        SET
          status = 'PENDING',
          updated_at = ?
        WHERE
          command_key = ? AND
          status = 'IN_FLIGHT'
      `)
      .run(
        now,
        commandKey,
      );

    return Number(outcome.changes) === 1;
  }

  async markCommandExecuted(
    commandKey: string,
    result: ManagementCommandResult,
  ): Promise<void> {
    const outcome = this.database
      .prepare(`
        UPDATE management_command_ledger
        SET
          status = 'EXECUTED',
          updated_at = ?,
          result_json = ?
        WHERE
          command_key = ? AND
          status = 'IN_FLIGHT'
      `)
      .run(
        result.executedAt,
        JSON.stringify(result),
        commandKey,
      );

    if (Number(outcome.changes) !== 1) {
      throw new Error(
        "Management command is not IN_FLIGHT; cannot mark EXECUTED.",
      );
    }
  }

  async markCommandFailed(
    commandKey: string,
    result: ManagementCommandResult,
  ): Promise<void> {
    const outcome = this.database
      .prepare(`
        UPDATE management_command_ledger
        SET
          status = 'FAILED',
          updated_at = ?,
          result_json = ?
        WHERE
          command_key = ? AND
          status = 'IN_FLIGHT'
      `)
      .run(
        result.executedAt,
        JSON.stringify(result),
        commandKey,
      );

    if (Number(outcome.changes) !== 1) {
      throw new Error(
        "Management command is not IN_FLIGHT; cannot mark FAILED.",
      );
    }
  }

  close(): void {
    this.database.close();
  }
}