import type { RiskAssessment, RiskContext } from "../models";

export interface IRiskEngine {
  evaluate(context: RiskContext): RiskAssessment;
}
