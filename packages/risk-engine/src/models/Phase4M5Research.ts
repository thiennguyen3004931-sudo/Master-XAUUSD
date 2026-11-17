import type { EntryCompressionCandidate } from "./EntryCompression";

export interface Phase4M5Bar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Phase4M5CandidateBuildRequest {
  bars: readonly Phase4M5Bar[];
  signalTimestamp: number;
  expiresAt: number;
  canonicalEntry: number;
  side: "BUY" | "SELL";
  maxBars?: number;
}

export interface Phase4M5CandidateBuildResult {
  candidates: EntryCompressionCandidate[];
  barsConsidered: number;
  sources: Record<string, number>;
}
