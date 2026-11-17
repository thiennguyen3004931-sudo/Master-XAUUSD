import type { StrategyAction, StrategyPlan } from "@xauusd/strategy-engine";
import type { BrokerOrderReceipt } from "./BrokerOrderReceipt";
import type { ExecutionStatus } from "./ExecutionStatus";
import type { NormalizedExecutionOrder } from "./NormalizedExecutionOrder";

export interface ExecutionRecord {
  id: string;
  idempotencyKey: string;
  correlationId?: string;
  strategyAction: StrategyAction;
  strategyPlan: StrategyPlan | null;
  order: NormalizedExecutionOrder | null;
  status: ExecutionStatus;
  receipt: BrokerOrderReceipt | null;
  createdAt: number;
  updatedAt: number;
}
