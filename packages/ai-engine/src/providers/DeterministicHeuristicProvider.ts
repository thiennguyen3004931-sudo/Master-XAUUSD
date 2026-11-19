import type { IAiProvider, IClock } from "../contracts";
import type {
  AiAction,
  AiFeatureContribution,
  AiProviderRequest,
  AiProviderResponse,
  AiStructuredOpinion
} from "../models";
import {
  NumberUtils,
  SystemClock
} from "../utils";

export interface DeterministicHeuristicProviderOptions {
  id?: string;
  model?: string;
}

export class DeterministicHeuristicProvider
  implements IAiProvider
{
  readonly id: string;
  readonly kind = "DETERMINISTIC" as const;
  readonly model: string;

  constructor(
    options:
      DeterministicHeuristicProviderOptions = {},
    private readonly clock: IClock = new SystemClock()
  ) {
    this.id = options.id ?? "heuristic-reviewer";
    this.model = options.model ?? "heuristic-v1";
  }

  async generate(
    request: AiProviderRequest
  ): Promise<AiProviderResponse> {
    const startedAt = this.clock.now();
    const features = request.features;
    const contributions: AiFeatureContribution[] = [];
    let score = 50;

    score += this.contribute(
      contributions,
      "strategyConfidence",
      features.strategyConfidence >= 80 ? 12 : -8,
      features.strategyConfidence >= 80
        ? "Strategy confidence is strong."
        : "Strategy confidence is below the preferred threshold."
    );
    score += this.contribute(
      contributions,
      "riskApproved",
      features.riskApproved ? 15 : -40,
      features.riskApproved
        ? "Risk Engine approved the trade."
        : "Risk Engine did not approve the trade."
    );
    score += this.contribute(
      contributions,
      "signalAccepted",
      features.signalAccepted ? 10 : -25,
      features.signalAccepted
        ? "Signal Engine accepted the direction."
        : "Signal Engine rejected or downgraded the signal."
    );
    score += this.contribute(
      contributions,
      "dataQuality",
      features.dataQuality >= 80 ? 8 : -10,
      features.dataQuality >= 80
        ? "Market data quality is high."
        : "Market data quality is weak."
    );
    score += this.contribute(
      contributions,
      "warmupComplete",
      features.warmupComplete ? 6 : -20,
      features.warmupComplete
        ? "Indicator warm-up is complete."
        : "Indicator warm-up is incomplete."
    );
    score += this.contribute(
      contributions,
      "orderRiskReward",
      features.orderRiskReward >= 1.8 ? 8 : -15,
      features.orderRiskReward >= 1.8
        ? "Risk-to-reward meets the minimum quality threshold."
        : "Risk-to-reward is too low."
    );
    score += this.contribute(
      contributions,
      "recentConsecutiveLosses",
      features.recentConsecutiveLosses >= 3
        ? -12
        : 2,
      features.recentConsecutiveLosses >= 3
        ? "Recent consecutive losses justify caution."
        : "Recent loss streak is controlled."
    );
    score += this.contribute(
      contributions,
      "backtestProfitFactor",
      features.backtestTradeCount >= 30
        ? features.backtestProfitFactor >= 1.2
          ? 8
          : -12
        : 0,
      features.backtestTradeCount >= 30
        ? features.backtestProfitFactor >= 1.2
          ? "Backtest profit factor supports the setup."
          : "Backtest profit factor is weak."
        : "Backtest sample is too small for a strong contribution."
    );

    score = NumberUtils.clamp(score, 0, 100);

    let action: AiAction = "CONFIRM";
    if (
      !features.riskApproved ||
      features.strategyAction === "REJECT" ||
      features.rejectionCount > 0
    ) {
      action = "REJECT";
    } else if (
      features.strategyAction !== "EXECUTE" ||
      score < 65 ||
      features.recentConsecutiveLosses >= 3
    ) {
      action = "DOWNGRADE_TO_WAIT";
    }

    const opinion: AiStructuredOpinion = {
      schemaVersion: request.schemaVersion,
      action,
      confidence: NumberUtils.round(
        Math.abs(score - 50) * 2
      ),
      marketQualityScore:
        NumberUtils.clamp(
          (features.analysisScore +
            features.dataQuality +
            features.regimeConfidence) /
            3,
          0,
          100
        ),
      executionQualityScore:
        NumberUtils.clamp(
          (features.strategyConfidence +
            features.signalConfidence +
            features.signalDirectionalEdge) /
            3,
          0,
          100
        ),
      riskQualityScore:
        NumberUtils.clamp(
          features.riskApproved
            ? 100 -
                features.projectedOpenRiskPercent * 5 -
                features.projectedMarginUsagePercent * 0.5
            : 0,
          0,
          100
        ),
      reasons: contributions
        .filter((item) => item.direction !== "NEUTRAL")
        .map((item) => item.explanation),
      warnings:
        features.recentConsecutiveLosses >= 3
          ? ["Recent consecutive losses are elevated."]
          : [],
      invalidationConditions: [
        "Risk Engine approval is revoked.",
        "Strategy plan expires.",
        "Market structure or signal direction changes."
      ],
      featureContributions: contributions
    };

    return {
      providerId: this.id,
      providerKind: this.kind,
      model: this.model,
      requestId: request.requestId,
      content: JSON.stringify(opinion),
      latencyMs:
        Math.max(0, this.clock.now() - startedAt),
      createdAt: this.clock.now()
    };
  }

  private contribute(
    output: AiFeatureContribution[],
    feature: string,
    impact: number,
    explanation: string
  ): number {
    output.push({
      feature,
      impact,
      direction:
        impact > 0
          ? "SUPPORT"
          : impact < 0
            ? "OPPOSE"
            : "NEUTRAL",
      explanation
    });
    return impact;
  }
}
