import type { Signal } from "@xauusd/types";
import type { SignalLevelPlan } from "@xauusd/signal-engine";
import type { ExposureProjection } from "./ExposureProjection";
import type { MarginProjection } from "./MarginProjection";
import type { PositionSizing } from "./PositionSizing";
import type { RiskBudget } from "./RiskBudget";

export interface RiskEvaluationDraft {
  signal: Signal | null;
  levels: SignalLevelPlan | null;
  budget: RiskBudget | null;
  sizing: PositionSizing | null;
  margin: MarginProjection | null;
  exposure: ExposureProjection | null;
}
