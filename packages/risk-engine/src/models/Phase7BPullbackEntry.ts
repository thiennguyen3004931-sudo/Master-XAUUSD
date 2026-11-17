import type { Phase7Side } from "./Phase7TrendRider";

export type Phase7BEntryState =
  | "ENTRY_IMMEDIATE"
  | "WAIT_PULLBACK"
  | "PULLBACK_STILL_TOO_WIDE"
  | "PULLBACK_ENTRY"
  | "PULLBACK_SETUP_INVALIDATED"
  | "PULLBACK_M15_ST_INVALIDATED"
  | "PULLBACK_M5_ST_INVALIDATED"
  | "PULLBACK_EXPIRED";

export interface Phase7BPendingPullback {
  signalId: string;
  side: Phase7Side;
  pattern: string;
  signalTimestamp: number;
  expiresAt: number;
  structuralStopPrice: number;
  structuralStopDistanceAtSignal: number;
  maxStopDistancePrice: number;
}

export interface Phase7BInitialEntryInput {
  signalId: string;
  side: Phase7Side;
  pattern: string;
  signalTimestamp: number;
  referenceEntryPrice: number;
  structuralStopPrice: number;
  maxStopDistancePrice?: number;
  waitMinutes?: number;
}

export interface Phase7BInitialEntryDecision {
  state: "ENTRY_IMMEDIATE" | "WAIT_PULLBACK";
  structuralStopDistance: number;
  structuralStopPrice: number;
  pending: Phase7BPendingPullback | null;
}

export interface Phase7BPullbackEvaluationInput {
  pending: Phase7BPendingPullback;
  timestamp: number;
  candidateEntryPrice: number;
  barLow: number;
  barHigh: number;
  setupStillValid: boolean;
  m15SupertrendAligned: boolean;
  m5SupertrendAligned: boolean;
}

export interface Phase7BPullbackEvaluation {
  state: Exclude<Phase7BEntryState, "ENTRY_IMMEDIATE" | "WAIT_PULLBACK">;
  structuralStopDistance: number;
  structuralStopPrice: number;
  entryPrice: number | null;
  terminal: boolean;
}
