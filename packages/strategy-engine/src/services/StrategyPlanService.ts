import type { TradingSession } from "@xauusd/types";
import type { StrategyEngineConfig } from "../config";
import type {
  MarketRegimeAssessment,
  StrategyCandidate,
  StrategyContext,
  StrategyPlan,
} from "../models";
import { TradeManagementService } from "./TradeManagementService";

export class StrategyPlanService {
  constructor(
    private readonly managementService = new TradeManagementService(),
  ) {}

  create(
    context: StrategyContext,
    candidate: StrategyCandidate,
    regime: MarketRegimeAssessment,
    session: TradingSession,
    generatedAt: number,
    config: StrategyEngineConfig,
  ): StrategyPlan {
    const order = context.riskAssessment.order;
    if (!order) {
      throw new Error("An approved order is required to create a strategy plan.");
    }

    return {
      order: { ...order },
      selectedStrategy: candidate,
      regime,
      session,
      management: this.managementService.create(context, candidate, generatedAt, config),
      expiresAt: generatedAt + config.maximumContextAgeMs,
      generatedAt,
    };
  }
}
