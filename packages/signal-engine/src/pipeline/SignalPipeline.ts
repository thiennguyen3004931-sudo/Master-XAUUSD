import { TradeDecision } from "@xauusd/types";
import type { ISignalEngine, ISignalRule } from "../contracts";
import {
  defaultSignalEngineConfig,
  type SignalEngineConfig,
} from "../config";
import type { SignalContext, SignalEngineResult } from "../models";
import {
  MaTrendConfluenceRule,
  PriceStructureConfluenceRule,
  SupplyDemandConfluenceRule,
  TrendFvgConfluenceRule,
  TrendVolumeConfluenceRule,
  VolumeProfileConfluenceRule,
} from "../rules";
import {
  SignalEligibilityService,
  SignalFactory,
  SignalLevelService,
  SignalScoreService,
} from "../services";
import { SignalConfigValidator, SignalInputValidator } from "../validators";

export class SignalPipeline implements ISignalEngine {
  private readonly config: SignalEngineConfig;
  private readonly rules: ISignalRule[];

  constructor(
    config: Partial<SignalEngineConfig> = {},
    rules?: readonly ISignalRule[],
    private readonly inputValidator = new SignalInputValidator(),
    private readonly configValidator = new SignalConfigValidator(),
    private readonly scoreService = new SignalScoreService(),
    private readonly eligibilityService = new SignalEligibilityService(),
    private readonly levelService = new SignalLevelService(),
    private readonly signalFactory = new SignalFactory(),
  ) {
    this.config = this.mergeConfig(config);
    this.configValidator.validate(this.config);
    this.rules = rules ? [...rules] : this.createDefaultRules();
  }

  generate(context: SignalContext): SignalEngineResult {
    this.inputValidator.validate(context);
    const generatedAt = context.evaluatedAt ?? Date.now();
    const ruleResults = this.rules.map(
      (rule) => rule.evaluate(context, this.config),
    );
    const score = this.scoreService.calculate(ruleResults);
    const diagnostics = this.eligibilityService.evaluate(
      context,
      score,
      this.config,
    );

    if (!diagnostics.accepted || score.direction === "NEUTRAL") {
      return {
        decision: TradeDecision.WAIT,
        signal: null,
        score,
        levels: null,
        rules: ruleResults,
        diagnostics,
        generatedAt,
      };
    }

    const levels = this.levelService.calculate(
      context,
      score.direction,
      this.config,
    );

    if (!levels) {
      return {
        decision: TradeDecision.WAIT,
        signal: null,
        score,
        levels: null,
        rules: ruleResults,
        diagnostics: {
          accepted: false,
          rejectionCodes: [
            ...diagnostics.rejectionCodes,
            "INVALID_LEVEL_PLAN",
          ],
          notes: diagnostics.notes,
        },
        generatedAt,
      };
    }

    const signal = this.signalFactory.create(
      context,
      score.direction,
      score,
      levels,
      ruleResults,
      this.config,
      generatedAt,
    );

    return {
      decision:
        score.direction === "BULLISH"
          ? TradeDecision.BUY
          : TradeDecision.SELL,
      signal,
      score,
      levels,
      rules: ruleResults,
      diagnostics,
      generatedAt,
    };
  }

  private mergeConfig(
    config: Partial<SignalEngineConfig>,
  ): SignalEngineConfig {
    return {
      ...defaultSignalEngineConfig,
      ...config,
      weights: {
        ...defaultSignalEngineConfig.weights,
        ...config.weights,
      },
    };
  }

  private createDefaultRules(): ISignalRule[] {
    return [
      new MaTrendConfluenceRule(),
      new PriceStructureConfluenceRule(),
      new TrendFvgConfluenceRule(),
      new SupplyDemandConfluenceRule(),
      new VolumeProfileConfluenceRule(),
      new TrendVolumeConfluenceRule(),
    ];
  }
}