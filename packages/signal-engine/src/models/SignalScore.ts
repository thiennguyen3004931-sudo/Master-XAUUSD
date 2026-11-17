import type { SignalDirection } from "./SignalDirection";

export interface SignalScore {
  direction: SignalDirection;
  bullishPoints: number;
  bearishPoints: number;
  maximumPoints: number;
  confidence: number;
  directionalEdge: number;
}
