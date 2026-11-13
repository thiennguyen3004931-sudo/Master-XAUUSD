import type { StrategyEvaluation } from "@xauusd/strategy-engine";
import type { ExecutionOrderType } from "./ExecutionOrderType";
import type { TimeInForce } from "./TimeInForce";

export interface ExecutionRequest {
  strategyEvaluation: StrategyEvaluation;
  orderType?: ExecutionOrderType;
  timeInForce?: TimeInForce;
  idempotencyKey?: string;
  correlationId?: string;
  requestedAt?: number;
}
