import type { SwingType } from "../enums/SwingType";

export interface SwingPoint {
  index: number;
  timestamp: number;
  price: number;
  high: number;
  low: number;
  close: number;
  type: SwingType;
  strength: number;
}
