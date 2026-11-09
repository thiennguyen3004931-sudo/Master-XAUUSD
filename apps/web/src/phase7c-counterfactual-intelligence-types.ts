export type Phase7CCounterfactualEvidenceVerdict = "EXACT" | "BOUNDED" | "UNAVAILABLE";
export type Phase7CCounterfactualFamily =
  | "FAST_MOVE_GIVEBACK"
  | "RULE_OBSERVATION"
  | "MANAGEMENT_EXIT_POLICY";
export type Phase7CCounterfactualStrategy = "TREND" | "SIDEWAY" | "REVERSAL";
export type Phase7CCounterfactualSide = "BUY" | "SELL";
export type Phase7CCounterfactualEntryType = "IMMEDIATE" | "PULLBACK" | "RECOVERY" | "UNKNOWN";

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

export interface Phase7CCounterfactualScenario {
  schemaVersion: "phase7c-counterfactual-intelligence-v1";
  scenarioId: string;
  tradeKey: string;
  positionId: string;
  strategy: Phase7CCounterfactualStrategy;
  side: Phase7CCounterfactualSide;
  entryType: Phase7CCounterfactualEntryType;
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
  delta: Phase7CCounterfactualOutcome;
  quality: { warnings: string[] };
  safety: {
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
  };
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
  schemaVersion: "phase7c-counterfactual-intelligence-v1";
  generatedAt: number;
  source: "PHASE7C_COUNTERFACTUAL_INTELLIGENCE";
  readOnly: true;
  shadowOnly: true;
  safety: {
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
  };
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
