export type Phase7CStrategyName = "TREND" | "SIDEWAY";
export type Phase7CEntrySide = "BUY" | "SELL";
export type Phase7CStrategyConditionStatus = "PASS" | "FAIL" | "IGNORED";
export type Phase7CVersionSnapshot = { version: number; valid: boolean };

export interface Phase7CTrendStrategyConditions {
  patternM15: boolean;
  supertrendM15: boolean;
  supertrendM5: boolean;
  validTrendStructure: boolean;
  ma20Ma50: boolean;
  fvg: boolean;
}

export interface Phase7CSidewayStrategyConditions {
  rangingRegime: boolean;
  recommendedModeSideway: boolean;
  minimumRegimeConfidence: boolean;
  supplyDemandRange: boolean;
  rangeEdge: boolean;
  m5Confirmation: boolean;
}

export interface Phase7CStrategyEntryConditionState {
  version: number;
  updatedAt: string;
  updatedBy: string;
  trend: Phase7CTrendStrategyConditions;
  sideway: Phase7CSidewayStrategyConditions;
}

export interface Phase7CStrategyEntryConditionObservation {
  passed: boolean;
  observed?: unknown;
}

export interface Phase7CStrategyEntryConditionResultRow {
  id: string;
  enabled: boolean;
  mandatory: boolean;
  status: Phase7CStrategyConditionStatus;
  observed: unknown;
}

export interface Phase7CStrategyEntryConditionEvaluation {
  configVersion: number;
  side: Phase7CEntrySide;
  anchorCondition: string;
  enabledCount: number;
  allEnabledPassed: boolean;
  failedConditions: string[];
  conditions: Phase7CStrategyEntryConditionResultRow[];
}

export const TREND_STRATEGY_CONDITION_IDS: readonly (keyof Phase7CTrendStrategyConditions)[];
export const SIDEWAY_STRATEGY_CONDITION_IDS: readonly (keyof Phase7CSidewayStrategyConditions)[];
export const STRATEGY_ENTRY_MANDATORY: Readonly<{
  TREND: readonly ["patternM15"];
  SIDEWAY: readonly ["rangeEdge"];
}>;

export function createVirtualStrategyEntryConditionState(): Phase7CStrategyEntryConditionState;

export function validateStrategyEntryConditionState(
  value: unknown,
  options?: { allowVirtualVersionZero?: boolean },
):
  | { valid: true; state: Phase7CStrategyEntryConditionState }
  | { valid: false; reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID"; error: string };

export function evaluateStrategyEntryConditions(input: {
  strategy: Phase7CStrategyName;
  config: Phase7CStrategyEntryConditionState;
  side: Phase7CEntrySide;
  observations: Record<string, Phase7CStrategyEntryConditionObservation | undefined>;
}): Phase7CStrategyEntryConditionEvaluation;

export function compareStrategyEntryConfigVersion(
  cycleSnapshot: Phase7CVersionSnapshot,
  currentSnapshot: Phase7CVersionSnapshot,
):
  | { ok: true }
  | {
      ok: false;
      reasonCode: "ENTRY_STRATEGY_CONFIG_INVALID" | "ENTRY_CONFIG_VERSION_CHANGED";
    };
