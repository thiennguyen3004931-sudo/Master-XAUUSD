import type { ExecutionRecord } from "@xauusd/execution-engine";

import type { DashboardSnapshot } from "../types/dashboard";
import { getControlState } from "./control.service";
import { getDashboardSnapshot } from "./dashboard.service";
import { getExecutionRepository } from "./execution-state.service";
import { getMt5AllPositions } from "./mt5-market.service";

const HARD_MAX_VOLUME = 0.01;
const HARD_MAX_RISK_USD = 5.25;
const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 60_000;

export type AutoExecutionSoakDecision =
  | "DISABLED"
  | "BLOCKED"
  | "WAIT"
  | "CANDIDATE_DRY_RUN"
  | "DUPLICATE_CANDIDATE"
  | "ERROR";

export interface AutoExecutionSoakConfig {
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
}

export interface AutoExecutionSoakReconciliation {
  consistent: boolean;
  brokerPositionCount: number;
  localOpenRecordCount: number;
  missingAtBroker: string[];
  missingLocally: string[];
  volumeMismatches: Array<{
    ticket: string;
    localVolume: number;
    brokerVolume: number;
  }>;
}

export interface AutoExecutionSoakResult {
  decision: AutoExecutionSoakDecision;
  reason:
    | "SOAK_DISABLED"
    | "DRY_RUN_REQUIRED"
    | "RECONCILIATION_INCONSISTENT"
    | "CONTROL_MODE_NOT_DEMO"
    | "EXISTING_OPEN_POSITION"
    | "NO_ACTIONABLE_INTENT"
    | "NOT_UPSTREAM_DEMO"
    | "INVALID_LEVELS"
    | "VOLUME_NOT_001"
    | "RISK_EXCEEDS_SOAK_LIMIT"
    | "DUPLICATE_CANDIDATE"
    | "CANDIDATE_ACCEPTED"
    | "EVALUATION_ERROR";
  evaluatedAt: number;
  candidateKey?: string;
  marketTimestamp?: number;
  direction?: "BUY" | "SELL";
  strategyId?: string | null;
  volume?: number;
  riskAmount?: number;
  reconciliation?: AutoExecutionSoakReconciliation;
  message: string;
}

export interface AutoExecutionSoakStatus {
  running: boolean;
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
  inFlight: boolean;
  runs: number;
  candidates: number;
  waits: number;
  blocked: number;
  duplicates: number;
  errors: number;
  lastRunAt: number | null;
  lastCandidateKey: string | null;
  lastResult: AutoExecutionSoakResult | null;
}

interface ControlSnapshot {
  mode: string;
  tradingEnabled: boolean;
  liveUnlockAvailable: false;
  updatedAt: number;
}

interface BrokerPositionSnapshot {
  ticket: string;
  volume: number;
}

export interface AutoExecutionSoakDependencies {
  getControl: () => ControlSnapshot;
  getSnapshot: () => Promise<DashboardSnapshot>;
  listOpenRecords: () => Promise<ExecutionRecord[]>;
  getBrokerPositions: () => Promise<BrokerPositionSnapshot[]>;
  now?: () => number;
}

function readBoolean(
  name: string,
  fallback: boolean,
): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true";
}

function readInterval(): number {
  const value = Number(
    process.env.AUTO_EXECUTION_SOAK_INTERVAL_MS ??
      DEFAULT_INTERVAL_MS,
  );

  if (!Number.isFinite(value)) {
    return DEFAULT_INTERVAL_MS;
  }

  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

export function readAutoExecutionSoakConfig():
  AutoExecutionSoakConfig {
  return {
    enabled: readBoolean(
      "AUTO_EXECUTION_SOAK_ENABLED",
      false,
    ),
    dryRun: readBoolean(
      "AUTO_EXECUTION_SOAK_DRY_RUN",
      true,
    ),
    intervalMs: readInterval(),
  };
}

function validPositive(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

function validTradeGeometry(
  direction: "BUY" | "SELL",
  entry: number,
  stopLoss: number,
  takeProfit: number,
): boolean {
  return direction === "BUY"
    ? stopLoss < entry && entry < takeProfit
    : takeProfit < entry && entry < stopLoss;
}

function volumeOf(record: ExecutionRecord): number | null {
  const value =
    record.receipt?.position?.volume ??
    record.receipt?.filledVolume;

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

export class AutoExecutionSoakController {
  private readonly now: () => number;
  private lastCandidateKey: string | null = null;

  constructor(
    private readonly config: AutoExecutionSoakConfig,
    private readonly dependencies: AutoExecutionSoakDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  async evaluateOnce(): Promise<AutoExecutionSoakResult> {
    const evaluatedAt = this.now();

    if (!this.config.enabled) {
      return {
        decision: "DISABLED",
        reason: "SOAK_DISABLED",
        evaluatedAt,
        message:
          "Auto-execution soak controller is disabled.",
      };
    }

    if (!this.config.dryRun) {
      return {
        decision: "BLOCKED",
        reason: "DRY_RUN_REQUIRED",
        evaluatedAt,
        message:
          "Phase 3E.5B is dry-run only. Broker mutation is not available.",
      };
    }

    try {
      const reconciliation =
        await this.reconcileReadOnly();

      if (!reconciliation.consistent) {
        return {
          decision: "BLOCKED",
          reason: "RECONCILIATION_INCONSISTENT",
          evaluatedAt,
          reconciliation,
          message:
            "Local durable execution state does not reconcile with broker positions.",
        };
      }

      const control = this.dependencies.getControl();

      if (
        control.mode !== "DEMO" ||
        !control.tradingEnabled ||
        control.liveUnlockAvailable !== false
      ) {
        return {
          decision: "BLOCKED",
          reason: "CONTROL_MODE_NOT_DEMO",
          evaluatedAt,
          reconciliation,
          message:
            "Dry-run candidate evaluation requires DEMO control mode. LIVE remains unavailable.",
        };
      }

      if (
        reconciliation.brokerPositionCount !== 0 ||
        reconciliation.localOpenRecordCount !== 0
      ) {
        return {
          decision: "BLOCKED",
          reason: "EXISTING_OPEN_POSITION",
          evaluatedAt,
          reconciliation,
          message:
            "Soak entry is blocked while any broker or durable local position is open.",
        };
      }

      const snapshot =
        await this.dependencies.getSnapshot();

      if (
        snapshot.source !== "UPSTREAM" ||
        snapshot.account.accountType !== "DEMO" ||
        snapshot.control.mode !== "DEMO" ||
        !snapshot.control.tradingEnabled ||
        snapshot.control.liveUnlockAvailable !== false
      ) {
        return {
          decision: "BLOCKED",
          reason: "NOT_UPSTREAM_DEMO",
          evaluatedAt,
          reconciliation,
          message:
            "Snapshot is not an UPSTREAM DEMO snapshot under locked LIVE control.",
        };
      }

      const direction = snapshot.signal.direction;

      if (
        (direction !== "BUY" && direction !== "SELL") ||
        !snapshot.risk.approved ||
        snapshot.strategy.action !== "EXECUTE" ||
        !snapshot.ai.executable
      ) {
        return {
          decision: "WAIT",
          reason: "NO_ACTIONABLE_INTENT",
          evaluatedAt,
          marketTimestamp: snapshot.market.timestamp,
          reconciliation,
          message:
            "No natural Risk-approved, Strategy-EXECUTE, AI-executable BUY/SELL intent.",
        };
      }

      const entry = snapshot.signal.entry;
      const stopLoss = snapshot.signal.stopLoss;
      const takeProfit = snapshot.signal.takeProfit;

      if (
        !validPositive(entry) ||
        !validPositive(stopLoss) ||
        !validPositive(takeProfit) ||
        !validTradeGeometry(
          direction,
          entry,
          stopLoss,
          takeProfit,
        )
      ) {
        return {
          decision: "BLOCKED",
          reason: "INVALID_LEVELS",
          evaluatedAt,
          direction,
          marketTimestamp: snapshot.market.timestamp,
          reconciliation,
          message:
            "Actionable intent has invalid entry/stop/target geometry.",
        };
      }

      const volume = snapshot.risk.positionSize;
      const riskAmount = snapshot.risk.riskAmount;

      if (
        !Number.isFinite(volume) ||
        Math.abs(volume - HARD_MAX_VOLUME) > 1e-8
      ) {
        return {
          decision: "BLOCKED",
          reason: "VOLUME_NOT_001",
          evaluatedAt,
          direction,
          volume,
          riskAmount,
          marketTimestamp: snapshot.market.timestamp,
          reconciliation,
          message:
            "Phase 3E.5 soak eligibility is hard-locked to exactly 0.01 lot.",
        };
      }

      if (
        !Number.isFinite(riskAmount) ||
        riskAmount <= 0 ||
        riskAmount > HARD_MAX_RISK_USD
      ) {
        return {
          decision: "BLOCKED",
          reason: "RISK_EXCEEDS_SOAK_LIMIT",
          evaluatedAt,
          direction,
          volume,
          riskAmount,
          marketTimestamp: snapshot.market.timestamp,
          reconciliation,
          message:
            `Soak risk must be positive and <= ${HARD_MAX_RISK_USD.toFixed(2)} USD.`,
        };
      }

      const strategyId =
        snapshot.strategy.strategyId ?? "NO_STRATEGY";

      const candidateKey = [
        "soak",
        snapshot.market.symbol,
        snapshot.market.timeframe,
        snapshot.market.timestamp,
        strategyId,
        direction,
      ].join(":");

      if (candidateKey === this.lastCandidateKey) {
        return {
          decision: "DUPLICATE_CANDIDATE",
          reason: "DUPLICATE_CANDIDATE",
          evaluatedAt,
          candidateKey,
          marketTimestamp: snapshot.market.timestamp,
          direction,
          strategyId: snapshot.strategy.strategyId,
          volume,
          riskAmount,
          reconciliation,
          message:
            "The same closed-candle candidate has already been observed by this dry-run process.",
        };
      }

      this.lastCandidateKey = candidateKey;

      return {
        decision: "CANDIDATE_DRY_RUN",
        reason: "CANDIDATE_ACCEPTED",
        evaluatedAt,
        candidateKey,
        marketTimestamp: snapshot.market.timestamp,
        direction,
        strategyId: snapshot.strategy.strategyId,
        volume,
        riskAmount,
        reconciliation,
        message:
          "Natural intent passed all 3E.5B dry-run gates. No broker mutation was attempted.",
      };
    } catch (error) {
      return {
        decision: "ERROR",
        reason: "EVALUATION_ERROR",
        evaluatedAt,
        message:
          error instanceof Error
            ? error.message
            : "Unknown dry-run evaluation error.",
      };
    }
  }

  private async reconcileReadOnly():
    Promise<AutoExecutionSoakReconciliation> {
    const [brokerPositions, localRecords] =
      await Promise.all([
        this.dependencies.getBrokerPositions(),
        this.dependencies.listOpenRecords(),
      ]);

    const brokerByTicket = new Map(
      brokerPositions.map((position) => [
        position.ticket,
        position,
      ]),
    );

    const localByTicket = new Map(
      localRecords.flatMap((record) =>
        record.receipt?.ticket
          ? [[record.receipt.ticket, record] as const]
          : [],
      ),
    );

    const missingAtBroker = localRecords.flatMap(
      (record) => {
        const ticket = record.receipt?.ticket;

        if (!ticket || !brokerByTicket.has(ticket)) {
          return [ticket ?? `record:${record.id}`];
        }

        return [];
      },
    );

    const missingLocally = brokerPositions.flatMap(
      (position) =>
        localByTicket.has(position.ticket)
          ? []
          : [position.ticket],
    );

    const volumeMismatches = localRecords.flatMap(
      (record) => {
        const ticket = record.receipt?.ticket;
        if (!ticket) return [];

        const broker = brokerByTicket.get(ticket);
        const localVolume = volumeOf(record);

        if (
          !broker ||
          localVolume === null ||
          Math.abs(broker.volume - localVolume) < 1e-8
        ) {
          return [];
        }

        return [{
          ticket,
          localVolume,
          brokerVolume: broker.volume,
        }];
      },
    );

    return {
      consistent:
        missingAtBroker.length === 0 &&
        missingLocally.length === 0 &&
        volumeMismatches.length === 0,
      brokerPositionCount: brokerPositions.length,
      localOpenRecordCount: localRecords.length,
      missingAtBroker,
      missingLocally,
      volumeMismatches,
    };
  }
}

function createRuntimeController():
  AutoExecutionSoakController {
  const repository = getExecutionRepository();

  return new AutoExecutionSoakController(
    readAutoExecutionSoakConfig(),
    {
      getControl: getControlState,
      getSnapshot: getDashboardSnapshot,
      listOpenRecords: () => repository.listOpen(),
      getBrokerPositions: async () => {
        const positions = await getMt5AllPositions();

        return positions.map((position) => ({
          ticket: position.ticket,
          volume: position.volume,
        }));
      },
    },
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let runtimeController:
  | AutoExecutionSoakController
  | null = null;

let runtimeStatus: AutoExecutionSoakStatus = {
  running: false,
  enabled: false,
  dryRun: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  inFlight: false,
  runs: 0,
  candidates: 0,
  waits: 0,
  blocked: 0,
  duplicates: 0,
  errors: 0,
  lastRunAt: null,
  lastCandidateKey: null,
  lastResult: null,
};

function applyResult(
  result: AutoExecutionSoakResult,
): void {
  runtimeStatus.runs += 1;
  runtimeStatus.lastRunAt = result.evaluatedAt;
  runtimeStatus.lastResult = result;

  if (result.candidateKey) {
    runtimeStatus.lastCandidateKey =
      result.candidateKey;
  }

  if (result.decision === "CANDIDATE_DRY_RUN") {
    runtimeStatus.candidates += 1;
  } else if (result.decision === "WAIT") {
    runtimeStatus.waits += 1;
  } else if (
    result.decision === "BLOCKED" ||
    result.decision === "DISABLED"
  ) {
    runtimeStatus.blocked += 1;
  } else if (
    result.decision === "DUPLICATE_CANDIDATE"
  ) {
    runtimeStatus.duplicates += 1;
  } else if (result.decision === "ERROR") {
    runtimeStatus.errors += 1;
  }
}

async function runtimeTick(): Promise<void> {
  if (!runtimeController || runtimeStatus.inFlight) {
    return;
  }

  runtimeStatus.inFlight = true;

  try {
    const result =
      await runtimeController.evaluateOnce();

    applyResult(result);

    console.log(
      `[SOAK-DRY-RUN] ${result.decision} ` +
      `${result.reason} · ${result.message}`,
    );
  } finally {
    runtimeStatus.inFlight = false;
  }
}

export function startAutoExecutionSoak(): void {
  if (timer || runtimeStatus.running) {
    return;
  }

  const config = readAutoExecutionSoakConfig();

  runtimeStatus = {
    ...runtimeStatus,
    enabled: config.enabled,
    dryRun: config.dryRun,
    intervalMs: config.intervalMs,
  };

  if (!config.enabled) {
    return;
  }

  if (!config.dryRun) {
    runtimeStatus.lastResult = {
      decision: "BLOCKED",
      reason: "DRY_RUN_REQUIRED",
      evaluatedAt: Date.now(),
      message:
        "3E.5B refuses to start when dry-run is false.",
    };
    runtimeStatus.blocked += 1;
    return;
  }

  runtimeController = createRuntimeController();
  runtimeStatus.running = true;

  void runtimeTick();

  timer = setInterval(
    () => void runtimeTick(),
    config.intervalMs,
  );

  timer.unref?.();
}

export function stopAutoExecutionSoak(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  runtimeController = null;
  runtimeStatus.running = false;
  runtimeStatus.inFlight = false;
}

export function getAutoExecutionSoakStatus():
  AutoExecutionSoakStatus {
  return structuredClone(runtimeStatus);
}