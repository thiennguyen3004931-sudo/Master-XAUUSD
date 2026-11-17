import type { AiEngineConfig } from "../config";
import type {
  AiAction,
  AiConsensus,
  AiOpinion
} from "../models";
import { NumberUtils } from "../utils";

export class ConsensusService {
  constructor(
    private readonly config: AiEngineConfig
  ) {}

  create(
    opinions: readonly AiOpinion[]
  ): AiConsensus | null {
    if (opinions.length === 0) return null;

    const counts = new Map<AiAction, number>();
    for (const opinion of opinions) {
      counts.set(
        opinion.action,
        (counts.get(opinion.action) ?? 0) + 1
      );
    }

    const ranking: AiAction[] = [
      "REJECT",
      "DOWNGRADE_TO_WAIT",
      "CONFIRM"
    ];
    const action = ranking
      .map((candidate) => ({
        candidate,
        count: counts.get(candidate) ?? 0
      }))
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }
        return (
          ranking.indexOf(left.candidate) -
          ranking.indexOf(right.candidate)
        );
      })[0]!.candidate;

    const agreeing = opinions.filter(
      (opinion) => opinion.action === action
    );
    const agreementRatio =
      agreeing.length / opinions.length;
    const confidence =
      NumberUtils.mean(
        agreeing.map((opinion) => opinion.confidence)
      );

    return {
      action,
      confidence: NumberUtils.round(confidence),
      agreementRatio:
        NumberUtils.round(agreementRatio),
      providerCount: opinions.length,
      validOpinionCount: opinions.length,
      opinions: [...opinions],
      dissentingProviders: opinions
        .filter(
          (opinion) => opinion.action !== action
        )
        .map((opinion) => opinion.providerId),
      reasons: this.unique(
        agreeing.flatMap((opinion) => opinion.reasons)
      ),
      warnings: this.unique(
        opinions.flatMap((opinion) => opinion.warnings)
      )
    };
  }

  isSufficient(consensus: AiConsensus): boolean {
    return (
      consensus.validOpinionCount >=
        this.config.minimumProviderCount &&
      consensus.agreementRatio >=
        this.config.minimumAgreementRatio &&
      consensus.confidence >=
        this.config.minimumOpinionConfidence
    );
  }

  private unique(values: readonly string[]): string[] {
    return [...new Set(values)];
  }
}
