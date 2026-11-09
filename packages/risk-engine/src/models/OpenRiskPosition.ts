import type { Position } from "@xauusd/types";

export interface OpenRiskPosition {
  position: Position;
  initialRiskAmount: number;
  currentRiskAmount?: number;
  marginUsed?: number;
}
