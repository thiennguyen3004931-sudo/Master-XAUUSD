import type { OrderSide } from "@xauusd/types";
import type { InstrumentRiskSpec } from "./InstrumentRiskSpec";

export type EntryCompressionSource =
  | "FVG"
  | "SUPPLY_DEMAND"
  | "MA20"
  | "MA50"
  | "VOLUME_PROFILE"
  | "OTHER_STRUCTURAL";

export interface EntryCompressionCandidate {
  price: number;
  source: EntryCompressionSource;
  timestamp: number;
  label?: string;
}

export interface EntryCompressionRequest {
  side: OrderSide;
  canonicalEntry: number;
  canonicalStopLoss: number;
  canonicalSignalTime: number;
  expiresAt: number;
  effectiveRiskCapUsd: number;
  instrument: InstrumentRiskSpec;
  candidates: readonly EntryCompressionCandidate[];
}

export interface EntryCompressionCandidateAssessment {
  candidate: EntryCompressionCandidate;
  favorableRetracement: boolean;
  canonicalStopPreserved: boolean;
  withinExecutionWindow: boolean;
  entryImprovement: number;
  riskAtMinVolumeUsd: number;
  feasibleAtMinVolume: boolean;
  rejectionCodes: string[];
}

export interface EntryCompressionResult {
  canonicalEntry: number;
  canonicalStopLoss: number;
  canonicalRiskAtMinVolumeUsd: number;
  canonicalFeasibleAtMinVolume: boolean;
  selectedEntry: number | null;
  selectedSource: EntryCompressionSource | null;
  selectedRiskAtMinVolumeUsd: number | null;
  rescuedAtMinVolume: boolean;
  assessments: EntryCompressionCandidateAssessment[];
}
