import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SemiAdoptionProtectionStatus =
  | "PENDING"
  | "PROTECTION_BLOCKED"
  | "PROTECTED"
  | "MANAGED";

export interface DurableSemiAdoptionState {
  version: 1;
  ownershipId: string;
  ticket: string;
  openingDealTicket: string;
  symbol: "XAUUSD";
  accountLogin: string;
  entrySource: "MANUAL";
  managementStrategy: "TREND";
  side: "LONG" | "SHORT";
  entry: number;
  initialVolume: number;
  expectedRemainingVolume: number;
  activationEpochMs: number;
  manualOpenedAt: number;
  managementStartedAt: number;
  initialStopDistance: 6;
  targetStopLoss: number;
  tightestStopLoss: number;
  protectionStatus: SemiAdoptionProtectionStatus;
  protectionReason: string;
  fixedTakeProfit: {
    enabled: boolean;
    targetPrice: number | null;
  };
  updatedAt: number;
}

interface SemiAdoptionRow {
  ownership_id: string;
  ticket: string;
  account_login: string;
  activation_epoch_ms: number;
  closed_at: number | null;
  closed_reason: string | null;
  state_json: string;
}

function cloneState(state: DurableSemiAdoptionState): DurableSemiAdoptionState {
  return structuredClone(state);
}

function parseState(row: SemiAdoptionRow | undefined): DurableSemiAdoptionState | null {
  if (!row || row.closed_at !== null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch (error) {
    throw new Error(
      `Persisted SEMI adoption state contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  validateState(parsed);
  return cloneState(parsed);
}

function validateState(value: unknown): asserts value is DurableSemiAdoptionState {
  const state = value as Partial<DurableSemiAdoptionState> | null;
  if (
    !state ||
    typeof state !== "object" ||
    state.version !== 1 ||
    typeof state.ownershipId !== "string" ||
    !state.ownershipId.trim() ||
    typeof state.ticket !== "string" ||
    !state.ticket.trim() ||
    typeof state.openingDealTicket !== "string" ||
    !state.openingDealTicket.trim() ||
    state.symbol !== "XAUUSD" ||
    typeof state.accountLogin !== "string" ||
    !state.accountLogin.trim() ||
    state.entrySource !== "MANUAL" ||
    state.managementStrategy !== "TREND" ||
    (state.side !== "LONG" && state.side !== "SHORT") ||
    !Number.isFinite(state.entry) ||
    Number(state.entry) <= 0 ||
    !Number.isFinite(state.initialVolume) ||
    Number(state.initialVolume) <= 0 ||
    !Number.isFinite(state.expectedRemainingVolume) ||
    Number(state.expectedRemainingVolume) < 0 ||
    !Number.isFinite(state.activationEpochMs) ||
    Number(state.activationEpochMs) <= 0 ||
    !Number.isFinite(state.manualOpenedAt) ||
    Number(state.manualOpenedAt) <= Number(state.activationEpochMs) ||
    !Number.isFinite(state.managementStartedAt) ||
    Number(state.managementStartedAt) < Number(state.manualOpenedAt) ||
    state.initialStopDistance !== 6 ||
    !Number.isFinite(state.targetStopLoss) ||
    Number(state.targetStopLoss) <= 0 ||
    !Number.isFinite(state.tightestStopLoss) ||
    Number(state.tightestStopLoss) <= 0 ||
    !isProtectionStatus(state.protectionStatus) ||
    typeof state.protectionReason !== "string" ||
    !state.protectionReason.trim() ||
    !state.fixedTakeProfit ||
    typeof state.fixedTakeProfit.enabled !== "boolean" ||
    (state.fixedTakeProfit.targetPrice !== null &&
      (!Number.isFinite(state.fixedTakeProfit.targetPrice) ||
        Number(state.fixedTakeProfit.targetPrice) <= 0)) ||
    !Number.isFinite(state.updatedAt)
  ) {
    throw new Error("SEMI adoption state failed structural validation.");
  }
}

function isProtectionStatus(value: unknown): value is SemiAdoptionProtectionStatus {
  return value === "PENDING" ||
    value === "PROTECTION_BLOCKED" ||
    value === "PROTECTED" ||
    value === "MANAGED";
}

function transitionAllowed(
  from: SemiAdoptionProtectionStatus,
  to: SemiAdoptionProtectionStatus,
): boolean {
  if (from === to) return true;
  if (from === "PENDING") {
    return to === "PROTECTION_BLOCKED" || to === "PROTECTED";
  }
  if (from === "PROTECTION_BLOCKED") {
    return to === "PROTECTED";
  }
  if (from === "PROTECTED") {
    return to === "MANAGED";
  }
  return false;
}

export class Phase7CSemiAdoptionStateRepository {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    const normalized = databasePath.trim();
    if (!normalized) {
      throw new Error("SEMI adoption database path cannot be blank.");
    }

    mkdirSync(dirname(normalized), { recursive: true });
    this.database = new DatabaseSync(normalized);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS phase7c_semi_adoptions (
        ticket TEXT PRIMARY KEY,
        ownership_id TEXT NOT NULL UNIQUE,
        account_login TEXT NOT NULL,
        activation_epoch_ms INTEGER NOT NULL,
        protection_status TEXT NOT NULL,
        closed_at INTEGER,
        closed_reason TEXT,
        updated_at INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_phase7c_semi_adoptions_active
        ON phase7c_semi_adoptions(closed_at, updated_at);
    `);
  }

  async save(state: DurableSemiAdoptionState): Promise<void> {
    validateState(state);

    const existing = this.findRawByTicket(state.ticket);
    if (existing) {
      if (existing.closed_at !== null) {
        throw new Error(
          `SEMI ownership ${existing.ownership_id} is closed and cannot be re-adopted.`,
        );
      }
      if (existing.ownership_id !== state.ownershipId) {
        throw new Error(
          `SEMI ticket ${state.ticket} ownership cannot change from ${existing.ownership_id} to ${state.ownershipId}.`,
        );
      }
      if (existing.account_login !== state.accountLogin) {
        throw new Error(
          `SEMI ticket ${state.ticket} account cannot change from ${existing.account_login} to ${state.accountLogin}.`,
        );
      }
      if (Number(existing.activation_epoch_ms) !== state.activationEpochMs) {
        throw new Error(
          `SEMI ticket ${state.ticket} activation ownership epoch cannot change.`,
        );
      }

      const previous = parseState(existing);
      if (!previous) {
        throw new Error(`SEMI ticket ${state.ticket} active state unexpectedly missing.`);
      }
      if (!transitionAllowed(previous.protectionStatus, state.protectionStatus)) {
        throw new Error(
          `Invalid SEMI protection transition ${previous.protectionStatus} -> ${state.protectionStatus}.`,
        );
      }
      if (state.updatedAt < previous.updatedAt) {
        throw new Error("SEMI adoption updatedAt cannot move backwards.");
      }

      const update = this.database.prepare(`
        UPDATE phase7c_semi_adoptions
        SET
          protection_status = ?,
          updated_at = ?,
          state_json = ?
        WHERE ticket = ? AND closed_at IS NULL
      `);
      const result = update.run(
        state.protectionStatus,
        state.updatedAt,
        JSON.stringify(state),
        state.ticket,
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`SEMI ticket ${state.ticket} update was not durable.`);
      }
      return;
    }

    const ownershipRow = this.database.prepare(`
      SELECT ownership_id, ticket, account_login, activation_epoch_ms,
             closed_at, closed_reason, state_json
      FROM phase7c_semi_adoptions
      WHERE ownership_id = ?
      LIMIT 1
    `).get(state.ownershipId) as SemiAdoptionRow | undefined;
    if (ownershipRow) {
      throw new Error(
        `SEMI ownership ${state.ownershipId} is already bound to ticket ${ownershipRow.ticket}.`,
      );
    }

    this.database.prepare(`
      INSERT INTO phase7c_semi_adoptions (
        ticket,
        ownership_id,
        account_login,
        activation_epoch_ms,
        protection_status,
        closed_at,
        closed_reason,
        updated_at,
        state_json
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      state.ticket,
      state.ownershipId,
      state.accountLogin,
      state.activationEpochMs,
      state.protectionStatus,
      state.updatedAt,
      JSON.stringify(state),
    );
  }

  async findByTicket(ticket: string): Promise<DurableSemiAdoptionState | null> {
    return parseState(this.findRawByTicket(ticket));
  }

  async listActive(): Promise<DurableSemiAdoptionState[]> {
    const rows = this.database.prepare(`
      SELECT ownership_id, ticket, account_login, activation_epoch_ms,
             closed_at, closed_reason, state_json
      FROM phase7c_semi_adoptions
      WHERE closed_at IS NULL
      ORDER BY updated_at ASC, ticket ASC
    `).all() as unknown as SemiAdoptionRow[];

    return rows.map((row) => {
      const state = parseState(row);
      if (!state) {
        throw new Error("Active SEMI adoption state unexpectedly missing.");
      }
      return state;
    });
  }

  async markClosed(
    ticket: string,
    closedAt: number,
    reason: string,
  ): Promise<void> {
    if (!Number.isFinite(closedAt) || closedAt <= 0) {
      throw new Error("SEMI close timestamp must be a positive finite value.");
    }
    if (!reason.trim()) {
      throw new Error("SEMI close reason cannot be blank.");
    }

    const existing = this.findRawByTicket(ticket);
    if (!existing) {
      throw new Error(`SEMI ticket ${ticket} does not exist.`);
    }
    if (existing.closed_at !== null) return;

    const result = this.database.prepare(`
      UPDATE phase7c_semi_adoptions
      SET closed_at = ?, closed_reason = ?, updated_at = ?
      WHERE ticket = ? AND closed_at IS NULL
    `).run(closedAt, reason.trim(), closedAt, ticket);

    if (Number(result.changes) !== 1) {
      throw new Error(`SEMI ticket ${ticket} close tombstone was not durable.`);
    }
  }

  async isOwnershipClosed(ownershipId: string): Promise<boolean> {
    const row = this.database.prepare(`
      SELECT closed_at
      FROM phase7c_semi_adoptions
      WHERE ownership_id = ?
      LIMIT 1
    `).get(ownershipId) as { closed_at: number | null } | undefined;
    return row?.closed_at !== null && row?.closed_at !== undefined;
  }

  close(): void {
    this.database.close();
  }

  private findRawByTicket(ticket: string): SemiAdoptionRow | undefined {
    return this.database.prepare(`
      SELECT ownership_id, ticket, account_login, activation_epoch_ms,
             closed_at, closed_reason, state_json
      FROM phase7c_semi_adoptions
      WHERE ticket = ?
      LIMIT 1
    `).get(ticket) as SemiAdoptionRow | undefined;
  }
}
