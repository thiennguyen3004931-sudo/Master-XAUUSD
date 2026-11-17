import type { Trend } from "@xauusd/types";

export type StructureEventType = "BOS" | "CHOCH";

export interface StructureEvent {
  id: string;
  type: StructureEventType;
  direction: Trend;
  level: number;
  candleIndex: number;
  timestamp: number;
  confirmed: boolean;
}
