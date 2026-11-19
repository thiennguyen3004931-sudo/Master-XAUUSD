import type { ExecutionEngineConfig } from "../config";
import type { IExecutionRule } from "../contracts";
import type {
  ExecutionPreflightDraft,
  ExecutionRequest,
  ExecutionRuleResult,
} from "../models";

export class QuoteFreshnessRule implements IExecutionRule {
  readonly name = "quote-freshness";

  evaluate(
    _request: ExecutionRequest,
    draft: ExecutionPreflightDraft,
    config: ExecutionEngineConfig,
  ): ExecutionRuleResult {
    const age =
      draft.quote === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, draft.evaluatedAt - draft.quote.timestamp);
    const passed =
      Number.isFinite(age) && age <= config.maxQuoteAgeMs;

    return {
      rule: this.name,
      passed,
      code: passed ? undefined : "QUOTE_STALE",
      message: passed
        ? "Execution quote is fresh."
        : "Execution quote is stale or unavailable.",
      metrics: {
        quoteAgeMs: age,
        maximumQuoteAgeMs: config.maxQuoteAgeMs,
      },
    };
  }
}
