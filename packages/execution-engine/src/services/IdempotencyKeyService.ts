import type { ExecutionRequest } from "../models";

export class IdempotencyKeyService {
  resolve(request: ExecutionRequest): string {
    const explicit = request.idempotencyKey?.trim();
    if (explicit) return explicit;

    const orderId =
      request.strategyEvaluation.plan?.order.clientOrderId?.trim();
    if (orderId) return orderId;

    const plan = request.strategyEvaluation.plan;
    if (plan) {
      return [
        "strategy",
        plan.order.symbol,
        plan.order.side,
        plan.order.entry,
        plan.generatedAt,
      ].join(":");
    }

    return [
      "strategy-rejected",
      request.strategyEvaluation.generatedAt,
      request.correlationId ?? "none",
    ].join(":");
  }
}
