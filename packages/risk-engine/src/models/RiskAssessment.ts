import type { Order, RiskResult } from "@xauusd/types";
import type { ExposureProjection } from "./ExposureProjection";
import type { MarginProjection } from "./MarginProjection";
import type { PositionSizing } from "./PositionSizing";
import type { RiskBudget } from "./RiskBudget";
import type { RiskDecision } from "./RiskDecision";
import type { RiskDiagnostics } from "./RiskDiagnostics";
import type { RiskRuleResult } from "./RiskRuleResult";

export interface RiskAssessment {
  approved: boolean;
  decision: RiskDecision;
  order: Order | null;
  commonResult: RiskResult<Order>;
  budget: RiskBudget | null;
  sizing: PositionSizing | null;
  margin: MarginProjection | null;
  exposure: ExposureProjection | null;
  rules: RiskRuleResult[];
  diagnostics: RiskDiagnostics;
  generatedAt: number;
}
