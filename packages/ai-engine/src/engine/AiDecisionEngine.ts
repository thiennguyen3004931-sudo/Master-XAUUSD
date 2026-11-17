import type {
  IAiAuditRepository,
  IAiCache,
  IAiEngine,
  IAiFeatureExtractor,
  IAiPolicy,
  IAiProvider,
  IClock
} from "../contracts";
import {
  defaultAiEngineConfig,
  type AiEngineConfig
} from "../config";
import type {
  AiContext,
  AiDecision,
  AiDiagnostics,
  AiProviderRequest
} from "../models";
import {
  InMemoryAiCache
} from "../cache";
import {
  ConservativeAiPolicy
} from "../policies";
import {
  PromptBuilder,
  defaultReviewPrompt
} from "../prompts";
import {
  InMemoryAiAuditRepository
} from "../repositories";
import {
  AiAuditService,
  AiFeatureExtractor,
  AiResponseParser,
  CacheKeyService,
  ConsensusService,
  ProviderOrchestrator
} from "../services";
import {
  AiConfigValidator,
  AiContextValidator
} from "../validators";
import {
  IdFactory,
  SystemClock
} from "../utils";

export class AiDecisionEngine implements IAiEngine {
  private readonly config: AiEngineConfig;
  private readonly parser: AiResponseParser;
  private readonly orchestrator:
    ProviderOrchestrator;
  private readonly consensusService:
    ConsensusService;
  private readonly policy: IAiPolicy;
  private readonly auditService:
    AiAuditService;

  constructor(
    providers: readonly IAiProvider[],
    config: Partial<AiEngineConfig> = {},
    private readonly cache: IAiCache =
      new InMemoryAiCache(),
    auditRepository:
      IAiAuditRepository =
      new InMemoryAiAuditRepository(),
    private readonly featureExtractor:
      IAiFeatureExtractor =
      new AiFeatureExtractor(),
    private readonly clock: IClock =
      new SystemClock(),
    private readonly inputValidator =
      new AiContextValidator(),
    private readonly configValidator =
      new AiConfigValidator(),
    private readonly promptBuilder =
      new PromptBuilder(),
    private readonly keyService =
      new CacheKeyService(),
    private readonly ids = new IdFactory()
  ) {
    this.config = {
      ...defaultAiEngineConfig,
      ...config
    };
    this.configValidator.validate(this.config);
    this.parser = new AiResponseParser(
      this.config
    );
    this.orchestrator =
      new ProviderOrchestrator(
        providers,
        this.parser,
        this.config,
        undefined,
        this.clock
      );
    this.consensusService =
      new ConsensusService(this.config);
    this.policy =
      new ConservativeAiPolicy(this.config);
    this.auditService =
      new AiAuditService(
        auditRepository,
        this.clock
      );
  }

  async review(
    context: AiContext
  ): Promise<AiDecision> {
    this.inputValidator.validate(context);
    const generatedAt =
      context.evaluatedAt ?? this.clock.now();
    const features =
      this.featureExtractor.extract({
        ...context,
        evaluatedAt: generatedAt
      });
    const cacheKey =
      this.keyService.create(
        this.config.promptVersion,
        this.config.schemaVersion,
        features
      );
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached.decision;
    }

    const request:
      AiProviderRequest = {
      requestId: this.ids.create(
        "ai-request",
        generatedAt
      ),
      promptVersion:
        this.config.promptVersion,
      schemaVersion:
        this.config.schemaVersion,
      messages: this.promptBuilder.build(
        defaultReviewPrompt,
        features,
        this.config
      ),
      features,
      metadata: {
        symbol: features.symbol,
        timeframe: features.timeframe,
        strategyId:
          features.strategyId ?? "none"
      },
      createdAt: generatedAt
    };

    const providerResult =
      await this.orchestrator.run(request);
    const consensus =
      this.consensusService.create(
        providerResult.opinions
      );
    const diagnostics =
      this.createDiagnostics(
        context,
        consensus,
        providerResult.failures.length,
        generatedAt
      );

    const consensusSufficient =
      consensus !== null &&
      this.consensusService.isSufficient(
        consensus
      );

    const policy =
      this.policy.apply(
        context,
        consensusSufficient
          ? consensus
          : null
      );

    if (!policy.executable) {
      diagnostics.accepted = false;
      diagnostics.rejectionCodes.push(
        policy.action === "REJECT"
          ? "POLICY_REJECTION"
          : "POLICY_DOWNGRADE"
      );
    }

    const decision: AiDecision = {
      executable:
        policy.executable &&
        diagnostics.accepted,
      originalStrategyEvaluation:
        context.strategyEvaluation,
      features,
      consensus,
      policy: {
        ...policy,
        executable:
          policy.executable &&
          diagnostics.accepted,
        order:
          policy.executable &&
          diagnostics.accepted
            ? policy.order
            : null
      },
      providerFailures:
        providerResult.failures,
      diagnostics,
      generatedAt
    };

    await this.cache.set(
      cacheKey,
      decision,
      this.clock.now() + this.config.cacheTtlMs
    );

    if (this.config.auditEnabled) {
      await this.auditService.record(
        request,
        decision
      );
    }

    return decision;
  }

  private createDiagnostics(
    context: AiContext,
    consensus:
      ReturnType<ConsensusService["create"]>,
    failureCount: number,
    generatedAt: number
  ): AiDiagnostics {
    const rejectionCodes:
      AiDiagnostics["rejectionCodes"] = [];
    const warnings: string[] = [];
    const notes: string[] = [];

    if (
      context.strategyEvaluation.action !==
        "EXECUTE" ||
      !context.strategyEvaluation.plan
    ) {
      rejectionCodes.push(
        "STRATEGY_NOT_EXECUTABLE"
      );
    }

    if (!context.riskAssessment.approved) {
      rejectionCodes.push(
        "RISK_NOT_APPROVED"
      );
    }

    const timestamps = [
      context.analysis.createdAt,
      context.indicators.generatedAt,
      context.signalResult.generatedAt,
      context.riskAssessment.generatedAt,
      context.strategyEvaluation.generatedAt
    ];
    const oldest = Math.min(...timestamps);
    if (
      generatedAt - oldest >
      this.config.contextMaxAgeMs
    ) {
      rejectionCodes.push("CONTEXT_STALE");
    }

    if (!consensus) {
      rejectionCodes.push(
        failureCount > 0
          ? "ALL_PROVIDERS_FAILED"
          : "PROVIDER_COUNT_TOO_LOW"
      );
    } else {
      if (
        consensus.validOpinionCount <
        this.config.minimumProviderCount
      ) {
        rejectionCodes.push(
          "PROVIDER_COUNT_TOO_LOW"
        );
      }
      if (
        consensus.agreementRatio <
        this.config.minimumAgreementRatio
      ) {
        rejectionCodes.push(
          "PROVIDER_AGREEMENT_TOO_LOW"
        );
      }
      if (
        consensus.confidence <
        this.config.minimumOpinionConfidence
      ) {
        rejectionCodes.push(
          "OPINION_CONFIDENCE_TOO_LOW"
        );
      }
      notes.push(...consensus.reasons);
      warnings.push(...consensus.warnings);
    }

    return {
      accepted: rejectionCodes.length === 0,
      rejectionCodes:
        [...new Set(rejectionCodes)],
      warnings:
        [...new Set(warnings)],
      notes:
        [...new Set(notes)]
    };
  }
}
