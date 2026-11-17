import type {
  IClock,
  IExecutionAdapter,
  IExecutionEngine,
  IExecutionRepository,
  IExecutionRule,
  IIdempotencyStore,
} from "../contracts";
import {
  defaultExecutionEngineConfig,
  type ExecutionEngineConfig,
} from "../config";
import type {
  ExecutionDiagnostics,
  ExecutionEngineResult,
  ExecutionPreflightDraft,
  ExecutionRecord,
  ExecutionRequest,
} from "../models";
import {
  AdapterConnectionRule,
  DuplicateRequestRule,
  OrderValidityRule,
  PlanExpiryRule,
  PlanPresenceRule,
  QuoteFreshnessRule,
  RateLimitRule,
  SlippageRule,
  SpreadRule,
  StopsDistanceRule,
  StrategyExecutableRule,
  SymbolConsistencyRule,
  VolumeRule,
} from "../rules";
import {
  ExecutionRecordFactory,
  ExecutionResultMapper,
  IdempotencyKeyService,
  OrderNormalizationService,
  SlippageService,
} from "../services";
import {
  InMemoryExecutionRepository,
  InMemoryIdempotencyStore,
} from "../repositories";
import {
  ExecutionConfigValidator,
  ExecutionInputValidator,
} from "../validators";
import { SystemClock } from "../utils";

export class ExecutionPipeline implements IExecutionEngine {
  private readonly config: ExecutionEngineConfig;
  private readonly rules: IExecutionRule[];

  constructor(
    private readonly adapter: IExecutionAdapter,
    config: Partial<ExecutionEngineConfig> = {},
    private readonly repository: IExecutionRepository =
      new InMemoryExecutionRepository(),
    private readonly idempotencyStore: IIdempotencyStore =
      new InMemoryIdempotencyStore(),
    rules?: readonly IExecutionRule[],
    private readonly clock: IClock = new SystemClock(),
    private readonly inputValidator =
      new ExecutionInputValidator(),
    private readonly configValidator =
      new ExecutionConfigValidator(),
    private readonly keyService =
      new IdempotencyKeyService(),
    private readonly normalizer =
      new OrderNormalizationService(),
    private readonly slippageService =
      new SlippageService(),
    private readonly recordFactory =
      new ExecutionRecordFactory(),
    private readonly resultMapper =
      new ExecutionResultMapper(),
  ) {
    this.config = {
      ...defaultExecutionEngineConfig,
      ...config,
    };
    this.configValidator.validate(this.config);
    this.rules = rules ? [...rules] : this.createDefaultRules();
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionEngineResult> {
    this.inputValidator.validate(request);
    const generatedAt =
      request.requestedAt ?? this.clock.now();
    const idempotencyKey = this.keyService.resolve(request);

    const existing = await this.repository.findByIdempotencyKey(
      idempotencyKey,
    );
    const existingLock = await this.idempotencyStore.get(
      idempotencyKey,
    );

    if (existing || existingLock) {
      return this.createDuplicateResult(
        existing,
        generatedAt,
      );
    }

    const acquired = await this.idempotencyStore.acquire(
      idempotencyKey,
      generatedAt + this.config.idempotencyTtlMs,
    );
    if (!acquired) {
      return this.createDuplicateResult(null, generatedAt);
    }

    let record: ExecutionRecord | null = null;

    try {
      const draft = await this.createDraft(
        request,
        idempotencyKey,
        generatedAt,
      );
      const ruleResults = this.rules.map((rule) =>
        rule.evaluate(request, draft, this.config),
      );
      const failed = ruleResults.filter((rule) => !rule.passed);

      const diagnostics: ExecutionDiagnostics = {
        accepted: failed.length === 0,
        rejectionCodes: failed.flatMap((result) =>
          result.code ? [result.code] : [],
        ),
        warnings: this.createWarnings(draft),
        notes: ruleResults.map((result) => result.message),
      };

      record = this.recordFactory.create(
        request,
        idempotencyKey,
        draft.normalizedOrder,
        failed.length === 0
          ? "SUBMITTING"
          : "REJECTED",
        generatedAt,
      );
      await this.repository.save(record);

      if (failed.length > 0 || !draft.normalizedOrder) {
        await this.idempotencyStore.complete(
          idempotencyKey,
          record.id,
          generatedAt + this.config.idempotencyTtlMs,
        );
        return {
          success: false,
          action: "REJECTED",
          record,
          rules: ruleResults,
          diagnostics,
          commonResult: this.resultMapper.map(
            false,
            record,
            diagnostics,
            generatedAt,
          ),
          generatedAt,
        };
      }

      const receipt = await this.adapter.placeOrder(
        draft.normalizedOrder,
      );
      record = {
        ...record,
        status: receipt.accepted
          ? receipt.status
          : "REJECTED",
        receipt,
        updatedAt: receipt.brokerTimestamp,
      };
      await this.repository.update(record);
      await this.idempotencyStore.complete(
        idempotencyKey,
        record.id,
        generatedAt + this.config.idempotencyTtlMs,
      );

      if (!receipt.accepted) {
        diagnostics.accepted = false;
        diagnostics.rejectionCodes.push("ADAPTER_REJECTED");
        diagnostics.notes.push(receipt.message);
      }

      const success =
        receipt.accepted &&
        ["FILLED", "PARTIALLY_FILLED"].includes(
          receipt.status,
        );

      return {
        success,
        action: success ? "EXECUTED" : "REJECTED",
        record,
        rules: ruleResults,
        diagnostics,
        commonResult: this.resultMapper.map(
          success,
          record,
          diagnostics,
          generatedAt,
        ),
        generatedAt,
      };
    } catch (error) {
      if (!this.config.failClosedOnAdapterError) {
        await this.idempotencyStore.release(idempotencyKey);
      }

      const message =
        error instanceof Error
          ? error.message
          : "Unknown execution adapter error.";

      const diagnostics: ExecutionDiagnostics = {
        accepted: false,
        rejectionCodes: ["ADAPTER_ERROR"],
        warnings: [],
        notes: [message],
      };

      if (record) {
        record = {
          ...record,
          status: "FAILED",
          updatedAt: this.clock.now(),
        };
        await this.repository.update(record);
        await this.idempotencyStore.complete(
          idempotencyKey,
          record.id,
          generatedAt + this.config.idempotencyTtlMs,
        );
      }

      return {
        success: false,
        action: "FAILED",
        record,
        rules: [],
        diagnostics,
        commonResult: this.resultMapper.map(
          false,
          record,
          diagnostics,
          generatedAt,
        ),
        generatedAt,
      };
    }
  }

  private async createDraft(
    request: ExecutionRequest,
    idempotencyKey: string,
    evaluatedAt: number,
  ): Promise<ExecutionPreflightDraft> {
    const plan = request.strategyEvaluation.plan;
    const adapterConnected =
      await this.adapter.isConnected();
    const duplicate =
      (await this.repository.findByIdempotencyKey(
        idempotencyKey,
      )) !== null;

    let quote = null;
    let spec = null;
    let normalizedOrder = null;
    let slippage = null;

    if (plan && adapterConnected) {
      [quote, spec] = await Promise.all([
        this.adapter.getQuote(plan.order.symbol),
        this.adapter.getSymbolSpec(plan.order.symbol),
      ]);

      normalizedOrder = this.normalizer.normalize(
        plan.order,
        spec,
        idempotencyKey,
        request.orderType ?? "MARKET",
        request.timeInForce ?? "IOC",
        plan.expiresAt,
      );
      slippage = this.slippageService.assess(
        normalizedOrder,
        quote,
        spec,
      );
    }

    return {
      adapterConnected,
      plan,
      quote,
      spec,
      normalizedOrder,
      slippage,
      duplicate,
      recentExecutionCount:
        await this.repository.countCreatedSince(
          evaluatedAt - 60_000,
        ),
      evaluatedAt,
    };
  }

  private createDuplicateResult(
    existing: ExecutionRecord | null,
    generatedAt: number,
  ): ExecutionEngineResult {
    const diagnostics: ExecutionDiagnostics = {
      accepted: false,
      rejectionCodes: ["DUPLICATE_REQUEST"],
      warnings: [],
      notes: [
        "The idempotency key is already reserved or completed.",
      ],
    };

    return {
      success: false,
      action: "DUPLICATE",
      record: existing,
      rules: [],
      diagnostics,
      commonResult: this.resultMapper.map(
        false,
        existing,
        diagnostics,
        generatedAt,
      ),
      generatedAt,
    };
  }

  private createWarnings(
    draft: ExecutionPreflightDraft,
  ): string[] {
    const warnings: string[] = [];

    if (draft.slippage?.favorable) {
      warnings.push(
        "The current quote is more favorable than the planned entry.",
      );
    }

    if (
      draft.normalizedOrder &&
      draft.plan &&
      draft.normalizedOrder.volume <
        draft.plan.order.volume
    ) {
      warnings.push(
        "Order volume was reduced to comply with broker volume limits.",
      );
    }

    return warnings;
  }

  private createDefaultRules(): IExecutionRule[] {
    return [
      new StrategyExecutableRule(),
      new PlanPresenceRule(),
      new PlanExpiryRule(),
      new AdapterConnectionRule(),
      new SymbolConsistencyRule(),
      new QuoteFreshnessRule(),
      new SpreadRule(),
      new SlippageRule(),
      new OrderValidityRule(),
      new VolumeRule(),
      new StopsDistanceRule(),
      new DuplicateRequestRule(),
      new RateLimitRule(),
    ];
  }
}
