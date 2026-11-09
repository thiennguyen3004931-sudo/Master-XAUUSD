import type { PositionSide } from "../enums/PositionSide";

export interface Position {
  ticket: string;
  symbol: string;
  side: PositionSide;
  volume: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  profit: number;
  swap: number;
  commission: number;
  openedAt?: number;
  closedAt?: number;
}
