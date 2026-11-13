import type { ExecutionRequest } from "../models";

export class ExecutionInputValidator {
  validate(request: ExecutionRequest): void {
    if (!request || !request.strategyEvaluation) {
      throw new TypeError(
        "Execution request must contain a strategy evaluation.",
      );
    }

    if (
      request.requestedAt !== undefined &&
      (!Number.isFinite(request.requestedAt) ||
        request.requestedAt <= 0)
    ) {
      throw new RangeError(
        "requestedAt must be a positive finite timestamp.",
      );
    }

    if (
      request.idempotencyKey !== undefined &&
      request.idempotencyKey.trim().length === 0
    ) {
      throw new Error("idempotencyKey cannot be blank.");
    }
  }
}
