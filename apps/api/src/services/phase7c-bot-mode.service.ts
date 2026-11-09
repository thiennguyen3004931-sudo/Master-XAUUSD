import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BotMode } from "@xauusd/strategy-engine";

export interface Phase7CBotModeState {
  mode: BotMode;
  updatedAt: string;
  updatedBy: string;
}

export interface Phase7CBotModeAuditEvent {
  event: "BOT_MODE_SET_ATTEMPT";
  fromMode: BotMode;
  toMode: BotMode;
  updatedAt: string;
  updatedBy: string;
  pid: number;
}

const VALID_MODES: readonly BotMode[] = ["AUTO", "TREND", "SIDEWAY", "SEMI", "PAUSE"];
const VALID_MODE_SET = new Set<BotMode>(VALID_MODES);
const WEB_AUTO_SOURCE = "web-control-center";

function defaultState(): Phase7CBotModeState {
  return {
    mode: "PAUSE",
    updatedAt: new Date(0).toISOString(),
    updatedBy: "safe-default",
  };
}

export function isPhase7CBotMode(value: unknown): value is BotMode {
  return typeof value === "string" && VALID_MODE_SET.has(value as BotMode);
}

export function getPhase7CBotModeOptions(): readonly BotMode[] {
  return VALID_MODES;
}

export function isPhase7CAutoActivationSourceAllowed(updatedBy: unknown): boolean {
  return typeof updatedBy === "string" && updatedBy.trim() === WEB_AUTO_SOURCE;
}

export class Phase7CBotModeService {
  private readonly filePath: string;
  private readonly auditPath: string;
  private readonly executionLockPath: string;

  constructor(
    filePath = process.env.PHASE7C_BOT_MODE_FILE,
    executionLockPath = process.env.PHASE7C_EXECUTION_LOCK_FILE || process.env.ZIQ_PHASE7C_EXECUTION_LOCK,
  ) {
    this.filePath = filePath?.trim()
      ? resolve(filePath)
      : resolve(process.cwd(), ".runtime", "phase7c-bot-mode.json");
    this.auditPath = resolve(dirname(this.filePath), "phase7c-bot-mode-audit.jsonl");
    this.executionLockPath = executionLockPath?.trim()
      ? resolve(executionLockPath)
      : resolve(dirname(this.filePath), "phase7c-executors", "phase7c-execution.lock");
  }

  get(): Phase7CBotModeState {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Phase7CBotModeState>;
      if (!isPhase7CBotMode(parsed.mode)) return defaultState();

      return {
        mode: parsed.mode,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        updatedBy: typeof parsed.updatedBy === "string" && parsed.updatedBy.trim()
          ? parsed.updatedBy.trim()
          : "unknown",
      };
    } catch {
      return defaultState();
    }
  }

  private appendAudit(event: Phase7CBotModeAuditEvent): void {
    mkdirSync(dirname(this.auditPath), { recursive: true });
    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private writeState(state: Phase7CBotModeState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
  }

  async waitForPauseBarrierDrain(
    timeoutMs = 5_000,
    pollMs = 25,
  ): Promise<{ drained: boolean; lockPath: string; waitedMs: number }> {
    const startedAt = Date.now();
    const safeTimeoutMs = Math.max(0, Math.trunc(timeoutMs));
    const safePollMs = Math.max(1, Math.trunc(pollMs));

    while (existsSync(this.executionLockPath)) {
      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= safeTimeoutMs) {
        return {
          drained: false,
          lockPath: this.executionLockPath,
          waitedMs,
        };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, safePollMs));
    }

    return {
      drained: true,
      lockPath: this.executionLockPath,
      waitedMs: Date.now() - startedAt,
    };
  }

  set(mode: BotMode, updatedBy = "operator"): Phase7CBotModeState {
    const previous = this.get();
    const normalizedUpdatedBy = updatedBy.trim() || "operator";
    const updatedAt = new Date().toISOString();
    const state: Phase7CBotModeState = {
      mode,
      updatedAt,
      updatedBy: normalizedUpdatedBy,
    };
    const event: Phase7CBotModeAuditEvent = {
      event: "BOT_MODE_SET_ATTEMPT",
      fromMode: previous.mode,
      toMode: mode,
      updatedAt,
      updatedBy: normalizedUpdatedBy,
      pid: process.pid,
    };

    if (mode === "AUTO" && !isPhase7CAutoActivationSourceAllowed(normalizedUpdatedBy)) {
      try {
        this.appendAudit(event);
      } catch {
        // Denial remains fail-closed even if provenance storage is unavailable.
      }
      throw new Error("AUTO activation is restricted to the manual Web control center.");
    }

    if (mode !== "PAUSE") {
      this.appendAudit(event);
      this.writeState(state);
      return state;
    }

    this.writeState(state);
    try {
      this.appendAudit(event);
    } catch {
      // PAUSE is the safety state and must remain available even if provenance storage fails.
    }
    return state;
  }
}

export const phase7CBotModeService = new Phase7CBotModeService();
