import { TradeDecision, type StrategyResult } from "@xauusd/types";
import type {
  StrategyAction,
  StrategyContext,
  StrategyDiagnostics,
  StrategySelection,
} from "../models";

export class StrategyResultMapper {
  map(
    action: StrategyAction,
    context: StrategyContext,
    selection: StrategySelection,
    diagnostics: StrategyDiagnostics,
    generatedAt: number,
  ): StrategyResult {
    const execute = action === "EXECUTE";
    return {
      decision: execute ? context.signalResult.decision : TradeDecision.WAIT,
      signal: execute ? context.signalResult.signal : null,
      confidence: selection.selected?.score ?? 0,
      reasons: execute
        ? selection.selected?.reasons ?? []
        : [
            ...diagnostics.rejectionCodes,
            ...diagnostics.warnings,
          ],
      createdAt: generatedAt,
    };
  }
}
