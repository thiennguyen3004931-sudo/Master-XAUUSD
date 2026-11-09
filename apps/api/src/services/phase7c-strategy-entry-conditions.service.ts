import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createVirtualStrategyEntryConditionState,
  validateStrategyEntryConditionState,
} from "../../../../scripts/phase7c-strategy-entry-conditions.mjs";
import type {
  Phase7CSidewayStrategyConditions,
  Phase7CStrategyEntryConditionState,
  Phase7CTrendStrategyConditions,
} from "../../../../scripts/phase7c-strategy-entry-conditions.mjs";

export type Phase7CStrategyEntryConfigErrorCode =
  | "ENTRY_STRATEGY_CONFIG_INVALID"
  | "CONFIG_VERSION_CONFLICT";

export class Phase7CStrategyEntryConfigError extends Error {
  constructor(
    public readonly code: Phase7CStrategyEntryConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase7CStrategyEntryConfigError";
  }
}

export type Phase7CStrategyEntryReadResult =
  | {
      state: Phase7CStrategyEntryConditionState;
      valid: true;
      persisted: boolean;
      error: null;
    }
  | {
      state: null;
      valid: false;
      persisted: true;
      error: string;
    };

export interface Phase7CStrategyEntryWriteInput {
  expectedVersion: number;
  source: string;
  trend: Phase7CTrendStrategyConditions;
  sideway: Phase7CSidewayStrategyConditions;
}

export type Phase7CStrategyEntrySaveGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      httpStatus: 409;
      code:
        | "STRATEGY_PROFILE_EDIT_REQUIRES_PAUSE"
        | "ACCOUNT_STATE_INVALID"
        | "BRIDGE_TELEMETRY_UNAVAILABLE"
        | "ACCOUNT_MODE_MISMATCH"
        | "XAUUSD_POSITION_COUNT_UNKNOWN"
        | "XAUUSD_POSITIONS_OPEN";
      message: string;
    };

const WRITE_KEYS = ["expectedVersion", "source", "trend", "sideway"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactWriteKeys(value: unknown): value is Phase7CStrategyEntryWriteInput {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...WRITE_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function writeJsonAtomic(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function evaluatePhase7CStrategyEntrySaveGuard(input: {
  mode: string;
  accountStateValid: boolean;
  bridgeReachable: boolean;
  accountModeMatches: boolean;
  openXauusdPositions: number | null;
}): Phase7CStrategyEntrySaveGuardResult {
  if (input.mode !== "PAUSE") {
    return {
      allowed: false,
      httpStatus: 409,
      code: "STRATEGY_PROFILE_EDIT_REQUIRES_PAUSE",
      message: "Strategy entry conditions may only be changed while BOT_MODE=PAUSE.",
    };
  }
  if (input.accountStateValid !== true) {
    return {
      allowed: false,
      httpStatus: 409,
      code: "ACCOUNT_STATE_INVALID",
      message: "Account-mode state is invalid; strategy entry settings fail closed.",
    };
  }
  if (input.bridgeReachable !== true) {
    return {
      allowed: false,
      httpStatus: 409,
      code: "BRIDGE_TELEMETRY_UNAVAILABLE",
      message: "Bridge telemetry is unavailable, so strategy entry save guards cannot be proven.",
    };
  }
  if (input.accountModeMatches !== true) {
    return {
      allowed: false,
      httpStatus: 409,
      code: "ACCOUNT_MODE_MISMATCH",
      message: "Bridge account mode does not match the configured account mode.",
    };
  }
  if (!Number.isInteger(input.openXauusdPositions) || input.openXauusdPositions === null || input.openXauusdPositions < 0) {
    return {
      allowed: false,
      httpStatus: 409,
      code: "XAUUSD_POSITION_COUNT_UNKNOWN",
      message: "XAUUSD position count must be known before strategy entry conditions can be changed.",
    };
  }
  if (input.openXauusdPositions > 0) {
    return {
      allowed: false,
      httpStatus: 409,
      code: "XAUUSD_POSITIONS_OPEN",
      message: "Strategy entry conditions may only be changed when XAUUSD positions are zero.",
    };
  }
  return { allowed: true };
}

export class Phase7CStrategyEntryConditionsService {
  private readonly filePath: string;

  constructor(
    filePath = process.env.PHASE7C_STRATEGY_ENTRY_CONDITIONS_FILE,
  ) {
    this.filePath = filePath?.trim()
      ? resolve(filePath)
      : resolve(process.cwd(), ".runtime", "phase7c-strategy-entry-conditions.json");
  }

  read(): Phase7CStrategyEntryReadResult {
    if (!existsSync(this.filePath)) {
      return {
        state: createVirtualStrategyEntryConditionState(),
        valid: true,
        persisted: false,
        error: null,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      const validation = validateStrategyEntryConditionState(raw, {
        allowVirtualVersionZero: false,
      });
      if (!validation.valid) {
        return {
          state: null,
          valid: false,
          persisted: true,
          error: validation.error,
        };
      }
      return {
        state: validation.state,
        valid: true,
        persisted: true,
        error: null,
      };
    } catch (error) {
      return {
        state: null,
        valid: false,
        persisted: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  set(input: Phase7CStrategyEntryWriteInput): Phase7CStrategyEntryReadResult {
    const current = this.read();
    if (!current.valid || !current.state) {
      throw new Phase7CStrategyEntryConfigError(
        "ENTRY_STRATEGY_CONFIG_INVALID",
        `Existing strategy entry condition state is invalid; normal save cannot repair it. ${current.error ?? ""}`.trim(),
      );
    }

    if (!hasExactWriteKeys(input)) {
      throw new Phase7CStrategyEntryConfigError(
        "ENTRY_STRATEGY_CONFIG_INVALID",
        "Strategy entry condition save payload must contain exactly expectedVersion, source, trend, and sideway.",
      );
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Phase7CStrategyEntryConfigError(
        "ENTRY_STRATEGY_CONFIG_INVALID",
        "expectedVersion must be a non-negative integer.",
      );
    }
    if (input.source !== "web-control-center") {
      throw new Phase7CStrategyEntryConfigError(
        "ENTRY_STRATEGY_CONFIG_INVALID",
        "Only source=web-control-center is accepted by the normal strategy entry condition save path.",
      );
    }
    if (input.expectedVersion !== current.state.version) {
      throw new Phase7CStrategyEntryConfigError(
        "CONFIG_VERSION_CONFLICT",
        `Strategy entry condition version conflict: expected ${input.expectedVersion}, current ${current.state.version}.`,
      );
    }

    const candidate = {
      version: current.state.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: input.source,
      trend: input.trend,
      sideway: input.sideway,
    };
    const validation = validateStrategyEntryConditionState(candidate, {
      allowVirtualVersionZero: false,
    });
    if (!validation.valid) {
      throw new Phase7CStrategyEntryConfigError(
        "ENTRY_STRATEGY_CONFIG_INVALID",
        validation.error,
      );
    }

    writeJsonAtomic(this.filePath, validation.state);
    return this.read();
  }
}

export const phase7CStrategyEntryConditionsService =
  new Phase7CStrategyEntryConditionsService();
