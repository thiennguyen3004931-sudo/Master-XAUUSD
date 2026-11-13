import type { RiskEngineConfig } from "../config";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export interface IRiskRule {
  readonly name: string;

  evaluate(
    context: RiskContext,
    draft: RiskEvaluationDraft,
    config: RiskEngineConfig,
  ): RiskRuleResult;
}
