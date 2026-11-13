import type {
  Phase7CPerformanceEntryType,
  Phase7CPerformanceSide,
  Phase7CPerformanceStrategy,
} from "./phase7c-performance-effectiveness.schema";

export const PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION =
  "phase7c-counterfactual-intelligence-v1" as const;

export type Phase7CCounterfactualEvidenceVerdict = "EXACT" | "BOUNDED" | "UNAVAILABLE";
export type Phase7CCounterfactualFamily =
  | "FAST_MOVE_GIVEBACK"
  | "RULE_OBSERVATION"
  | "MANAGEMENT_EXIT_POLICY";

export interface Phase7CCounterfactualParameters {
  description: string;
  activationPrice: number | null;
  givebackPrice: number | null;
  ruleId: string | null;
  ruleState: "PASSED" | "BLOCKED" | "ALTERNATIVE" | null;
  managementFamily: string | null;
}

export interface Phase7CCounterfactualOutcome {
  exitPrice: number | null;
  netPnl: number | null;
  realizedR: number | null;
  lockedProfitPrice: number | null;
}

export interface Phase7CCounterfactualDelta {
  exitPrice: number | null;
  netPnl: number | null;
  realizedR: number | null;
  lockedProfitPrice: number | null;
}

export interface Phase7CCounterfactualSafety {
  readOnly: true;
  shadowOnly: true;
  runtimeMutation: false;
  strategyMutation: false;
  riskMutation: false;
  orderMutation: false;
  positionMutation: false;
  modeMutation: false;
  armMutation: false;
  autoApply: false;
  autoRetune: false;
  liveTestOrder: false;
}

export interface Phase7CCounterfactualScenario {
  schemaVersion: typeof PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION;
  scenarioId: string;
  tradeKey: string;
  positionId: string;
  strategy: Phase7CPerformanceStrategy;
  side: Phase7CPerformanceSide;
  entryType: Phase7CPerformanceEntryType;
  regime: string | null;
  family: Phase7CCounterfactualFamily;
  mode: "SHADOW_ONLY";
  baseline: Phase7CCounterfactualParameters;
  alternative: Phase7CCounterfactualParameters;
  evidence: {
    verdict: Phase7CCounterfactualEvidenceVerdict;
    sources: string[];
  };
  actualOutcome: Phase7CCounterfactualOutcome;
  shadowOutcome: Phase7CCounterfactualOutcome;
  delta: Phase7CCounterfactualDelta;
  quality: {
    warnings: string[];
  };
  safety: Phase7CCounterfactualSafety;
}

export interface Phase7CCounterfactualFamilyAggregate {
  family: Phase7CCounterfactualFamily;
  scenarioCount: number;
  exactCount: number;
  boundedCount: number;
  unavailableCount: number;
  averageDeltaExitPrice: number | null;
  averageDeltaLockedProfitPrice: number | null;
  improvementCount: number;
  deteriorationCount: number;
}

export interface Phase7CCounterfactualSnapshot {
  schemaVersion: typeof PHASE7C_COUNTERFACTUAL_INTELLIGENCE_SCHEMA_VERSION;
  generatedAt: number;
  source: "PHASE7C_COUNTERFACTUAL_INTELLIGENCE";
  readOnly: true;
  shadowOnly: true;
  safety: Phase7CCounterfactualSafety;
  summary: {
    tradeCount: number;
    scenarioCount: number;
    exactCount: number;
    boundedCount: number;
    unavailableCount: number;
    evidenceQualifiedCount: number;
    evidenceCoveragePercent: number;
  };
  aggregates: {
    family: Phase7CCounterfactualFamilyAggregate[];
  };
  scenarios: Phase7CCounterfactualScenario[];
  notes: string[];
}

export interface Phase7CCounterfactualTradeIdentity {
  tradeKey: string;
  positionId: string;
  strategy: Phase7CPerformanceStrategy;
  side: Phase7CPerformanceSide;
  entryType: Phase7CPerformanceEntryType;
  regime: string | null;
}
