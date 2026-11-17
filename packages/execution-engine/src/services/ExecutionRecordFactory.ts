import type {
  ExecutionRecord,
  ExecutionStatus,
  NormalizedExecutionOrder,
} from "../models";
import type { ExecutionRequest } from "../models";
import { IdFactory } from "../utils";

export class ExecutionRecordFactory {
  constructor(private readonly ids = new IdFactory()) {}

  create(
    request: ExecutionRequest,
    idempotencyKey: string,
    order: NormalizedExecutionOrder | null,
    status: ExecutionStatus,
    timestamp: number,
  ): ExecutionRecord {
    return {
      id: this.ids.create("execution", timestamp),
      idempotencyKey,
      correlationId: request.correlationId,
      strategyAction: request.strategyEvaluation.action,
      strategyPlan: request.strategyEvaluation.plan,
      order,
      status,
      receipt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
}
