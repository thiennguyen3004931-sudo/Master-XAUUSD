export interface Phase7CTrendModeGateInput {
  activeMode?: unknown;
  regime?: unknown;
  demo?: unknown;
}

export interface Phase7CTrendModeGateDecision {
  allowed: boolean;
  activeMode: string;
  recommendedMode: string | null;
  regime?: string;
  regimeConfidence?: number | null;
  reversalDirection?: string | null;
  reversalSide?: string | null;
  reversalTimestamp?: number | null;
  signalSide?: string | null;
  signalTimestamp?: number | null;
  reason: string;
  detail: string;
}

export function evaluateAutoTrendEntryModeGate(
  input: Phase7CTrendModeGateInput,
): Phase7CTrendModeGateDecision;
