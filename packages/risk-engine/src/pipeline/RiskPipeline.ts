import type { Order } from "@xauusd/types";
import type { IRiskEngine, IRiskRule } from "../contracts";
import {
  defaultRiskEngineConfig,
  type RiskEngineConfig,
} from "../config";
import type {
  RiskAssessment,
  RiskContext,
  RiskDiagnostics,
  RiskEvaluationDraft,
} from "../models";
import {
  AccountHealthRule,
  ConsecutiveLossRule,
  CooldownRule,
  DailyLossRule,
  DrawdownRule,
  ExposureRule,
  LevelIntegrityRule,
  MarginRule,
  PositionLimitRule,
  PositionSizeRule,
  RiskRewardRule,
  SignalAcceptanceRule,
  SpreadRule,
} from "../rules";
import {
  ExposureService,
  MarginService,
  PositionSizeService,
  RiskBudgetService,
  RiskOrderFactory,
  RiskResultMapper,
} from "../services";
import {
  RiskConfigValidator,
  RiskInputValidator,
} from "../validators";

export class RiskPipeline implements IRiskEngine {
  private readonly config: RiskEngineConfig;
  private readonly rules: IRiskRule[];

  constructor(
    config: Partial<RiskEngineConfig> = {},
    rules?: readonly IRiskRule[],
    private readonly inputValidator = new RiskInputValidator(),
    private readonly configValidator = new RiskConfigValidator(),
    private readonly budgetService = new RiskBudgetService(),
    private readonly positionSizeService = new PositionSizeService(),
    private readonly marginService = new MarginService(),
    private readonly exposureService = new ExposureService(),
    private readonly orderFactory = new RiskOrderFactory(),
    private readonly resultMapper = new RiskResultMapper(),
  ) {
    this.config = {
      ...defaultRiskEngineConfig,
      ...config,
    };
    this.configValidator.validate(this.config);
    this.rules = rules ? [...rules] : this.createDefaultRules();
  }

  evaluate(context: RiskContext): RiskAssessment {
    this.inputValidator.validate(context);
    const generatedAt = context.evaluatedAt ?? Date.now();
    const draft = this.createDraft(context);
    const ruleResults = this.rules.map((rule) =>
      rule.evaluate(context, draft, this.config),
    );
    const failedRules = ruleResults.filter((result) => !result.passed);

    const diagnostics: RiskDiagnostics = {
      accepted: failedRules.length === 0,
      rejectionCodes: failedRules.flatMap((result) =>
        result.code ? [result.code] : [],
      ),
      warnings: this.createWarnings(draft),
      notes: ruleResults.map((result) => result.message),
    };

    let order: Order | null = null;
    if (
      diagnostics.accepted &&
      draft.sizing &&
      draft.sizing.volume > 0
    ) {
      order = this.orderFactory.create(context, draft.sizing);
    }

    const approved = diagnostics.accepted && order !== null;
    if (!approved) {
      diagnostics.accepted = false;
    }

    return {
      approved,
      decision: approved ? "APPROVE" : "REJECT",
      order,
      commonResult: this.resultMapper.map(
        approved,
        order,
        diagnostics,
        draft.sizing,
      ),
      budget: draft.budget,
      sizing: draft.sizing,
      margin: draft.margin,
      exposure: draft.exposure,
      rules: ruleResults,
      diagnostics,
      generatedAt,
    };
  }

  private createDraft(context: RiskContext): RiskEvaluationDraft {
    const signal = context.signalResult.signal;
    const levels = context.signalResult.levels;

    if (!signal || !levels) {
      return {
        signal: signal ?? null,
        levels: levels ?? null,
        budget: null,
        sizing: null,
        margin: null,
        exposure: this.exposureService.calculate(context, 0),
      };
    }

    const budget = this.budgetService.calculate(context, this.config);
    const sizing = this.positionSizeService.calculate(
      levels.entry,
      levels.stopLoss,
      context.account.equity,
      budget,
      context.instrument,
    );
    const margin = this.marginService.calculate(
      context,
      levels.entry,
      sizing.volume,
      context.instrument,
    );
    const exposure = this.exposureService.calculate(
      context,
      sizing.actualRiskAmount,
    );

    return {
      signal,
      levels,
      budget,
      sizing,
      margin,
      exposure,
    };
  }

  private createWarnings(draft: RiskEvaluationDraft): string[] {
    const warnings: string[] = [];

    if (draft.sizing?.cappedAtMaximum) {
      warnings.push(
        "Calculated volume exceeded the instrument maximum and was capped.",
      );
    }

    if (
      draft.budget &&
      draft.budget.approvedRiskAmount <
        draft.budget.requestedRiskAmount
    ) {
      warnings.push(
        "Risk budget was reduced because portfolio risk capacity was limited.",
      );
    }

    return warnings;
  }

  private createDefaultRules(): IRiskRule[] {
    return [
      new SignalAcceptanceRule(),
      new LevelIntegrityRule(),
      new RiskRewardRule(),
      new AccountHealthRule(),
      new DailyLossRule(),
      new DrawdownRule(),
      new PositionLimitRule(),
      new ExposureRule(),
      new SpreadRule(),
      new CooldownRule(),
      new ConsecutiveLossRule(),
      new PositionSizeRule(),
      new MarginRule(),
    ];
  }
}
