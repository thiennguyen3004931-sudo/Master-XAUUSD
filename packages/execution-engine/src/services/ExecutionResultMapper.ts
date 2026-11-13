import type { ExecutionResult } from "@xauusd/types";
import type {
  ExecutionDiagnostics,
  ExecutionRecord,
} from "../models";

export class ExecutionResultMapper {
  map(
    success: boolean,
    record: ExecutionRecord | null,
    diagnostics: ExecutionDiagnostics,
    generatedAt: number,
  ): ExecutionResult {
    return {
      success,
      ticket: record?.receipt?.ticket,
      message: success
        ? record?.receipt?.message ?? "Order executed."
        : diagnostics.rejectionCodes.join(", ") ||
          record?.receipt?.message ||
          "Execution failed.",
      executedAt: success
        ? record?.receipt?.brokerTimestamp ?? generatedAt
        : undefined,
    };
  }
}
