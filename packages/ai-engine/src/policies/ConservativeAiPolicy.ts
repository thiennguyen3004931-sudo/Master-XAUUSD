import type { IAiPolicy } from "../contracts";
import type { AiEngineConfig } from "../config";
import type {
  AiConsensus,
  AiContext,
  AiPolicyResult
} from "../models";
import { NumberUtils } from "../utils";

export class ConservativeAiPolicy
  implements IAiPolicy
{
  constructor(
    private readonly config: AiEngineConfig
  ) {}

  apply(
    context: AiContext,
    consensus: AiConsensus | null
  ): AiPolicyResult {
    const strategy =
      context.strategyEvaluation;
    const originalConfidence =
      strategy.selection.selected?.score ?? 0;
    const reasons: string[] = [];
    const warnings: string[] = [];

    if (
      strategy.action !== "EXECUTE" ||
      !strategy.plan
    ) {
      return {
        action: "REJECT",
        executable: false,
        order: null,
        originalStrategyConfidence:
          originalConfidence,
        adjustedConfidence: 0,
        policyReasons: [
          "AI cannot upgrade a WAIT or REJECT strategy to EXECUTE."
        ],
        policyWarnings: []
      };
    }

    if (
      !context.riskAssessment.approved ||
      !context.riskAssessment.order
    ) {
      return {
        action: "REJECT",
        executable: false,
        order: null,
        originalStrategyConfidence:
          originalConfidence,
        adjustedConfidence: 0,
        policyReasons: [
          "Risk Engine approval and an approved order are mandatory."
        ],
        policyWarnings: []
      };
    }

    if (!consensus) {
      return {
        action: this.config.failClosed
          ? "DOWNGRADE_TO_WAIT"
          : "CONFIRM",
        executable: !this.config.failClosed,
        order: this.config.failClosed
          ? null
          : { ...context.riskAssessment.order },
        originalStrategyConfidence:
          originalConfidence,
        adjustedConfidence:
          this.config.failClosed
            ? 0
            : originalConfidence,
        policyReasons: [
          "No valid AI consensus was available."
        ],
        policyWarnings: [
          this.config.failClosed
            ? "Fail-closed policy downgraded execution to WAIT."
            : "Fail-open policy retained the original strategy."
        ]
      };
    }

    const adjustment =
      NumberUtils.clamp(
        consensus.confidence -
          originalConfidence,
        -this.config.maximumConfidenceAdjustment,
        this.config.maximumConfidenceAdjustment
      );
    const adjustedConfidence =
      NumberUtils.clamp(
        originalConfidence + adjustment,
        0,
        100
      );

    if (consensus.action === "REJECT") {
      reasons.push(
        "AI consensus rejected the trade."
      );
      return {
        action: "REJECT",
        executable: false,
        order: null,
        originalStrategyConfidence:
          originalConfidence,
        adjustedConfidence,
        policyReasons: reasons,
        policyWarnings: consensus.warnings
      };
    }

    if (
      consensus.action === "DOWNGRADE_TO_WAIT"
    ) {
      reasons.push(
        "AI consensus downgraded the trade to WAIT."
      );
      return {
        action: "DOWNGRADE_TO_WAIT",
        executable: false,
        order: null,
        originalStrategyConfidence:
          originalConfidence,
        adjustedConfidence,
        policyReasons: reasons,
        policyWarnings: consensus.warnings
      };
    }

    reasons.push(
      "AI consensus confirmed the existing risk-approved plan."
    );
    warnings.push(...consensus.warnings);

    return {
      action: "CONFIRM",
      executable: true,
      order: {
        ...context.riskAssessment.order
      },
      originalStrategyConfidence:
        originalConfidence,
      adjustedConfidence,
      policyReasons: reasons,
      policyWarnings: warnings
    };
  }
}
