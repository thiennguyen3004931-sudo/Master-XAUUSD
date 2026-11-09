import type { RiskEngineConfig } from "../config";
import type { IRiskRule } from "../contracts";
import type {
  RiskContext,
  RiskEvaluationDraft,
  RiskRuleResult,
} from "../models";

export class AccountHealthRule implements IRiskRule {
  readonly name = "account-health";

  evaluate(
    context: RiskContext,
    _draft: RiskEvaluationDraft,
    _config: RiskEngineConfig,
  ): RiskRuleResult {
    const { account } = context;
    const passed =
      Number.isFinite(account.balance) &&
      Number.isFinite(account.equity) &&
      Number.isFinite(account.freeMargin) &&
      account.balance > 0 &&
      account.equity > 0 &&
      account.freeMargin >= 0 &&
      account.leverage > 0;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "ACCOUNT_UNHEALTHY",
      message: passed
        ? "Account health metrics are valid."
        : "Account balance, equity, free margin or leverage is invalid.",
    };
  }
}
