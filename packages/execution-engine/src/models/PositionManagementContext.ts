import type { TradeManagementPlan } from "@xauusd/strategy-engine";
import type { Position } from "@xauusd/types";
import type { ExecutionQuote } from "./ExecutionQuote";
import type { PositionManagementState } from "./PositionManagementState";
import type { SymbolExecutionSpec } from "./SymbolExecutionSpec";
import type { TrendStructureSnapshot } from "./TrendStructureSnapshot";

export interface PositionManagementPlan {
  order: {
    symbol: string;
    stopLoss: number;
  };
  management: TradeManagementPlan;
}

export interface PositionManagementContext {
  plan: PositionManagementPlan;
  position: Position;
  quote: ExecutionQuote;
  spec: SymbolExecutionSpec;
  atr: number;
  state: PositionManagementState;
  trendStructure?: TrendStructureSnapshot;
  evaluatedAt?: number;
}
