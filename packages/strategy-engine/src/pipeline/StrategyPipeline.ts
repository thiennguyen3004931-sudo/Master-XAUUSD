import type { IStrategyEngine, IStrategyModule, IStrategyRule } from "../contracts";
import { defaultStrategyEngineConfig, type StrategyEngineConfig } from "../config";
import type {
  BotMode,
  MarketRegime,
  StrategyAction,
  StrategyContext,
  StrategyDiagnostics,
  StrategyEvaluation,
  StrategyEvaluationDraft,
} from "../models";
import { MarketRegimeClassifier, SessionClassifier } from "../classifiers";
import { RangeMeanReversionStrategy, TrendContinuationStrategy } from "../strategies";
import {
  CandidateScoreRule,
  CandidateSelectionRule,
  ContextFreshnessRule,
  OrderPresenceRule,
  RegimeConfidenceRule,
  RiskApprovalRule,
  SelectionEdgeRule,
  SessionRule,
  SignalAcceptanceRule,
} from "../rules";
import {
  StrategyPlanService,
  StrategyResultMapper,
  StrategySelectionService,
} from "../services";
import { StrategyConfigValidator, StrategyInputValidator } from "../validators";

export class StrategyPipeline implements IStrategyEngine {
  private readonly config: StrategyEngineConfig;
  private readonly modules: IStrategyModule[];
  private readonly rules: IStrategyRule[];

  constructor(
    config: Partial<StrategyEngineConfig> = {},
    modules?: readonly IStrategyModule[],
    rules?: readonly IStrategyRule[],
    private readonly inputValidator = new StrategyInputValidator(),
    private readonly configValidator = new StrategyConfigValidator(),
    private readonly regimeClassifier = new MarketRegimeClassifier(),
    private readonly sessionClassifier = new SessionClassifier(),
    private readonly selectionService = new StrategySelectionService(),
    private readonly planService = new StrategyPlanService(),
    private readonly resultMapper = new StrategyResultMapper(),
  ) {
    this.config = {
      ...defaultStrategyEngineConfig,
      ...config,
      strategyWeights: {
        ...defaultStrategyEngineConfig.strategyWeights,
        ...(config.strategyWeights ?? {}),
      },
      maximumHoldingMinutes: {
        ...defaultStrategyEngineConfig.maximumHoldingMinutes,
        ...(config.maximumHoldingMinutes ?? {}),
      },
    };
    this.configValidator.validate(this.config);
    this.modules = modules ? [...modules] : this.createDefaultModules();
    this.rules = rules ? [...rules] : this.createDefaultRules();
  }

  evaluate(context: StrategyContext): StrategyEvaluation {
    this.inputValidator.validate(context);
    const generatedAt = context.evaluatedAt ?? Date.now();
    const session = context.session ?? this.sessionClassifier.classify(generatedAt);
    const regime = this.regimeClassifier.classify(context, this.config);
    const botMode = context.botMode ?? "AUTO";
    const recommendedBotMode = this.recommendBotMode(regime.regime);
    const activeModules = this.modulesForMode(botMode);
    const candidates = activeModules.map((module) =>
      module.evaluate(context, regime, session, this.config),
    );
    const selection = this.selectionService.select(candidates);
    const draft: StrategyEvaluationDraft = { session, regime, selection };
    const ruleResults = this.rules.map((rule) => rule.evaluate(context, draft, this.config));
    const failed = ruleResults.filter((rule) => !rule.passed);

    const diagnostics: StrategyDiagnostics = {
      accepted: botMode !== "PAUSE" && failed.length === 0,
      rejectionCodes: failed.flatMap((result) => result.code ? [result.code] : []),
      warnings: [
        ...(selection.selected?.warnings ?? []),
        `BOT_MODE_ACTIVE: ${botMode}.`,
        `BOT_MODE_RECOMMENDED: ${recommendedBotMode} for market regime ${regime.regime}.`,
        ...regime.regime === "UNCERTAIN" ? ["Market regime remains uncertain; PAUSE is recommended."] : [],
        ...regime.regime === "REVERSAL" ? ["TRANSITION_RISK: reversal risk detected; both trading bots should remain paused."] : [],
        ...regime.regime === "RANGING"
          ? ["SIDEWAY_CONFIRMED: Supply/Demand range detected; SIDEWAY mode is recommended and Trend bot should remain paused."]
          : [],
        ...botMode === "PAUSE"
          ? ["BOT_MODE_PAUSE: Strategy execution is disabled by operator."]
          : [],
        ...botMode !== "AUTO" && botMode !== "PAUSE" && botMode !== recommendedBotMode
          ? [`BOT_MODE_MISMATCH: ${botMode} is selected while ${recommendedBotMode} is recommended; incompatible strategies remain ineligible.`]
          : [],
      ],
      notes: [
        ...regime.reasons,
        ...ruleResults.map((result) => result.message),
      ],
    };

    const action = botMode === "PAUSE" ? "WAIT" : this.resolveAction(failed);
    const plan = action === "EXECUTE" && selection.selected
      ? this.planService.create(context, selection.selected, regime, session, generatedAt, this.config)
      : null;

    return {
      action,
      plan,
      regime,
      botMode,
      recommendedBotMode,
      selection,
      rules: ruleResults,
      diagnostics,
      commonResult: this.resultMapper.map(action, context, selection, diagnostics, generatedAt),
      generatedAt,
    };
  }

  private resolveAction(failed: ReturnType<IStrategyRule["evaluate"]>[]): StrategyAction {
    if (failed.length === 0) return "EXECUTE";
    return failed.some((result) => result.actionOnFailure === "REJECT")
      ? "REJECT"
      : "WAIT";
  }

  private modulesForMode(botMode: BotMode): IStrategyModule[] {
    if (botMode === "PAUSE") return [];
    if (botMode === "TREND") {
      return this.modules.filter((module) => module.id === "TREND_CONTINUATION");
    }
    if (botMode === "SIDEWAY") {
      return this.modules.filter((module) => module.id === "RANGE_MEAN_REVERSION");
    }
    return this.modules;
  }

  private recommendBotMode(regime: MarketRegime): BotMode {
    if (regime === "RANGING") return "SIDEWAY";
    if (regime === "TRENDING" || regime === "BREAKOUT") return "TREND";
    return "PAUSE";
  }

  private createDefaultModules(): IStrategyModule[] {
    return [
      new TrendContinuationStrategy(),
      new RangeMeanReversionStrategy(),
    ];
  }

  private createDefaultRules(): IStrategyRule[] {
    return [
      new SignalAcceptanceRule(),
      new RiskApprovalRule(),
      new ContextFreshnessRule(),
      new CandidateSelectionRule(),
      new CandidateScoreRule(),
      new SelectionEdgeRule(),
      new SessionRule(),
      new RegimeConfidenceRule(),
      new OrderPresenceRule(),
    ];
  }
}
