import type { Order, RiskResult } from "@xauusd/types";
import type {
  RiskDiagnostics,
  PositionSizing,
} from "../models";

export class RiskResultMapper {
  map(
    approved: boolean,
    order: Order | null,
    diagnostics: RiskDiagnostics,
    sizing: PositionSizing | null,
  ): RiskResult<Order> {
    return {
      approved,
      reason: approved
        ? "Risk checks approved the trade."
        : diagnostics.rejectionCodes.join(", ") || "Risk checks rejected the trade.",
      riskAmount: sizing?.actualRiskAmount,
      riskPercent: sizing?.actualRiskPercent,
      positionSize: sizing?.volume,
      position: order ?? undefined,
    };
  }
}
