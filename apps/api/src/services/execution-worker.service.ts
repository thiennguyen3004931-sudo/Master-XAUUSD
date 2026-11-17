import type {
  ExecutionEngineResult,
  ExecutionRequest,
  IExecutionRepository,
  ReconciliationResult,
} from "@xauusd/execution-engine";

import type {
  CanonicalDecisionBundle,
} from "./dashboard.service";

const HARD_VOLUME = 0.01;
const MAX_RISK_USD = 5.25;
const COOLDOWN_MS = 15 * 60_000;

export interface ExecutionWorkerConfig {
  enabled: boolean;
  executionEnabled: boolean;
  hardVolume: number;
  maxRiskUsd: number;
  cooldownMs: number;
}

export interface ExecutionWorkerControl {
  mode: string;
  tradingEnabled: boolean;
  liveUnlockAvailable: false;
  updatedAt: number;
}

export interface ExecutionWorkerDependencies {
  getControl: () => ExecutionWorkerControl;
  getDecisionBundle:
    () => Promise<CanonicalDecisionBundle>;
  repository: IExecutionRepository;
  reconcile: () => Promise<ReconciliationResult>;
  execute:
    (request: ExecutionRequest) =>
      Promise<ExecutionEngineResult>;
  now?: () => number;
}

export type ExecutionWorkerDecision =
  | "DISABLED"
  | "BLOCKED"
  | "WAIT"
  | "READY"
  | "DUPLICATE"
  | "EXECUTED"
  | "REJECTED"
  | "ERROR";

export interface ExecutionWorkerResult {
  decision: ExecutionWorkerDecision;
  reason:
    | "WORKER_DISABLED"
    | "EXECUTION_DISABLED"
    | "STARTUP_RECONCILIATION_REQUIRED"
    | "RECONCILIATION_INCONSISTENT"
    | "CONTROL_MODE_NOT_DEMO"
    | "OPEN_POSITION_EXISTS"
    | "NO_ACTIONABLE_INTENT"
    | "AI_ORDER_MISSING"
    | "AI_ORDER_DIVERGENCE"
    | "VOLUME_NOT_001"
    | "RISK_EXCEEDS_LIMIT"
    | "PLAN_EXPIRED"
    | "DUPLICATE_CANDLE"
    | "COOLDOWN_ACTIVE"
    | "READY_NOT_EXECUTED"
    | "EXECUTION_ACCEPTED"
    | "EXECUTION_REJECTED"
    | "WORKER_ERROR";
  evaluatedAt: number;
  idempotencyKey?: string;
  marketTimestamp?: number;
  execution?: ExecutionEngineResult;
  message: string;
}

export function defaultExecutionWorkerConfig():
  ExecutionWorkerConfig {
  return {
    enabled: false,
    executionEnabled: false,
    hardVolume: HARD_VOLUME,
    maxRiskUsd: MAX_RISK_USD,
    cooldownMs: COOLDOWN_MS,
  };
}

function almostEqual(
  left: number,
  right: number,
): boolean {
  return Math.abs(left - right) < 1e-8;
}

function ordersEquivalent(
  left: {
    symbol: string;
    side: string;
    volume: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
  },
  right: {
    symbol: string;
    side: string;
    volume: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
  },
): boolean {
  return (
    left.symbol === right.symbol &&
    left.side === right.side &&
    almostEqual(left.volume, right.volume) &&
    almostEqual(left.entry, right.entry) &&
    almostEqual(left.stopLoss, right.stopLoss) &&
    almostEqual(left.takeProfit, right.takeProfit)
  );
}

export class ExecutionWorkerController {
  private initialized = false;
  private startupConsistent = false;
  private readonly now: () => number;

  constructor(
    private readonly config: ExecutionWorkerConfig,
    private readonly dependencies:
      ExecutionWorkerDependencies,
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  async initialize(): Promise<boolean> {
    const reconciliation =
      await this.dependencies.reconcile();

    this.initialized = true;
    this.startupConsistent =
      reconciliation.consistent;

    return this.startupConsistent;
  }

  async evaluateOnce():
    Promise<ExecutionWorkerResult> {
    const evaluatedAt = this.now();

    if (!this.config.enabled) {
      return {
        decision: "DISABLED",
        reason: "WORKER_DISABLED",
        evaluatedAt,
        message: "Execution worker is disabled.",
      };
    }

    if (!this.initialized) {
      return {
        decision: "BLOCKED",
        reason: "STARTUP_RECONCILIATION_REQUIRED",
        evaluatedAt,
        message:
          "Worker must complete startup reconciliation before evaluating an execution.",
      };
    }

    if (!this.startupConsistent) {
      return {
        decision: "BLOCKED",
        reason: "RECONCILIATION_INCONSISTENT",
        evaluatedAt,
        message:
          "Startup broker/local reconciliation is inconsistent.",
      };
    }

    try {
      const reconciliation =
        await this.dependencies.reconcile();

      if (!reconciliation.consistent) {
        return {
          decision: "BLOCKED",
          reason: "RECONCILIATION_INCONSISTENT",
          evaluatedAt,
          message:
            "Broker/local reconciliation became inconsistent.",
        };
      }

      const control =
        this.dependencies.getControl();

      if (
        control.mode !== "DEMO" ||
        !control.tradingEnabled ||
        control.liveUnlockAvailable !== false
      ) {
        return {
          decision: "BLOCKED",
          reason: "CONTROL_MODE_NOT_DEMO",
          evaluatedAt,
          message:
            "Execution worker requires DEMO control mode. LIVE remains unavailable.",
        };
      }

      const openRecords =
        await this.dependencies.repository.listOpen();

      if (openRecords.length !== 0) {
        return {
          decision: "BLOCKED",
          reason: "OPEN_POSITION_EXISTS",
          evaluatedAt,
          message:
            "Worker is single-position fail-closed during DEMO soak.",
        };
      }

      const bundle =
        await this.dependencies.getDecisionBundle();

      const {
        snapshot,
        strategyEvaluation,
        aiDecision,
        riskAssessment,
        marketTimestamp,
      } = bundle;

      const plan = strategyEvaluation.plan;

      if (
        snapshot.source !== "UPSTREAM" ||
        snapshot.account.accountType !== "DEMO" ||
        snapshot.control.mode !== "DEMO" ||
        !snapshot.control.tradingEnabled ||
        snapshot.control.liveUnlockAvailable !== false ||
        !riskAssessment.approved ||
        strategyEvaluation.action !== "EXECUTE" ||
        !plan ||
        !aiDecision.executable
      ) {
        return {
          decision: "WAIT",
          reason: "NO_ACTIONABLE_INTENT",
          evaluatedAt,
          marketTimestamp,
          message:
            "No natural canonical Risk-approved, Strategy-EXECUTE, AI-executable intent.",
        };
      }

      const aiOrder = aiDecision.policy.order;

      if (!aiOrder) {
        return {
          decision: "BLOCKED",
          reason: "AI_ORDER_MISSING",
          evaluatedAt,
          marketTimestamp,
          message:
            "AI marked the decision executable but did not provide an executable policy order.",
        };
      }

      if (
        !ordersEquivalent(
          plan.order,
          aiOrder,
        )
      ) {
        return {
          decision: "BLOCKED",
          reason: "AI_ORDER_DIVERGENCE",
          evaluatedAt,
          marketTimestamp,
          message:
            "AI policy order differs from the canonical strategy plan. Adjusted-order execution is not implemented yet.",
        };
      }

      if (
        !Number.isFinite(plan.order.volume) ||
        !almostEqual(
          plan.order.volume,
          this.config.hardVolume,
        )
      ) {
        return {
          decision: "BLOCKED",
          reason: "VOLUME_NOT_001",
          evaluatedAt,
          marketTimestamp,
          message:
            "DEMO auto-execution soak is hard-locked to exactly 0.01 lot.",
        };
      }

      const riskAmount =
        riskAssessment.sizing?.actualRiskAmount ??
        riskAssessment.budget?.approvedRiskAmount ??
        0;

      if (
        !Number.isFinite(riskAmount) ||
        riskAmount <= 0 ||
        riskAmount > this.config.maxRiskUsd
      ) {
        return {
          decision: "BLOCKED",
          reason: "RISK_EXCEEDS_LIMIT",
          evaluatedAt,
          marketTimestamp,
          message:
            `Canonical risk must be positive and <= ${this.config.maxRiskUsd.toFixed(2)} USD.`,
        };
      }

      if (
        !Number.isFinite(plan.expiresAt) ||
        plan.expiresAt <= evaluatedAt
      ) {
        return {
          decision: "BLOCKED",
          reason: "PLAN_EXPIRED",
          evaluatedAt,
          marketTimestamp,
          message:
            "Canonical strategy plan expired before worker execution.",
        };
      }

      if (
        !Number.isFinite(marketTimestamp) ||
        marketTimestamp <= 0
      ) {
        return {
          decision: "BLOCKED",
          reason: "WORKER_ERROR",
          evaluatedAt,
          message:
            "Closed-candle market timestamp is invalid.",
        };
      }

      const idempotencyKey = [
        "auto",
        snapshot.market.symbol,
        snapshot.market.timeframe,
        marketTimestamp,
      ].join(":");

      const existing =
        await this.dependencies.repository
          .findByIdempotencyKey(idempotencyKey);

      if (existing) {
        return {
          decision: "DUPLICATE",
          reason: "DUPLICATE_CANDLE",
          evaluatedAt,
          idempotencyKey,
          marketTimestamp,
          message:
            "This closed M15 candle already has a durable execution record.",
        };
      }

      const recent =
        await this.dependencies.repository
          .countCreatedSince(
            evaluatedAt - this.config.cooldownMs,
          );

      if (recent > 0) {
        return {
          decision: "BLOCKED",
          reason: "COOLDOWN_ACTIVE",
          evaluatedAt,
          idempotencyKey,
          marketTimestamp,
          message:
            "A durable execution record exists inside the 15-minute worker cooldown.",
        };
      }

      if (!this.config.executionEnabled) {
        return {
          decision: "READY",
          reason: "READY_NOT_EXECUTED",
          evaluatedAt,
          idempotencyKey,
          marketTimestamp,
          message:
            "Canonical candidate passed worker gates, but execution wiring remains disabled.",
        };
      }

      const request: ExecutionRequest = {
        strategyEvaluation,
        orderType: "MARKET",
        timeInForce: "IOC",
        idempotencyKey,
        correlationId: idempotencyKey,
        requestedAt: evaluatedAt,
      };

      const execution =
        await this.dependencies.execute(request);

      if (
        execution.success &&
        execution.action === "EXECUTED"
      ) {
        return {
          decision: "EXECUTED",
          reason: "EXECUTION_ACCEPTED",
          evaluatedAt,
          idempotencyKey,
          marketTimestamp,
          execution,
          message:
            "Execution Engine accepted the canonical DEMO worker request.",
        };
      }

      return {
        decision: "REJECTED",
        reason: "EXECUTION_REJECTED",
        evaluatedAt,
        idempotencyKey,
        marketTimestamp,
        execution,
        message:
          "Execution Engine rejected or failed the canonical worker request.",
      };
    } catch (error) {
      return {
        decision: "ERROR",
        reason: "WORKER_ERROR",
        evaluatedAt,
        message:
          error instanceof Error
            ? error.message
            : "Unknown execution worker error.",
      };
    }
  }
}