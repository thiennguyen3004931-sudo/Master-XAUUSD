import type { StrategyEngineConfig } from "../config";
import type {
  StrategyCandidate,
  StrategyContext,
  TradeManagementPlan,
} from "../models";

const TREND_TRAILING_ACTIVATE_PRICE = 6;
const TREND_STRUCTURE_TRAIL_PRICE = 10;
const TREND_POSITIVE_LOCK_PRICE = 0.5;
const TREND_SWING_BUFFER_ATR = 0.25;
const TREND_MIN_DISTANCE_ATR = 0.5;
const TREND_ATR_FALLBACK_MULTIPLE = 1.5;

export class TradeManagementService {
  create(
    context: StrategyContext,
    candidate: StrategyCandidate,
    generatedAt: number,
    config: StrategyEngineConfig,
  ): TradeManagementPlan {
    const order = context.riskAssessment.order;
    const levels = context.signalResult.levels;

    if (!order || !levels) {
      throw new Error(
        "Trade management requires an approved order and signal levels.",
      );
    }

    const maximumHoldingMinutes =
      config.maximumHoldingMinutes[candidate.strategyId];

    const cancelIfNotFilledAfterMinutes =
      Math.min(
        60,
        Math.max(
          15,
          Math.round(maximumHoldingMinutes / 8),
        ),
      );

    const trendContinuation =
      candidate.strategyId === "TREND_CONTINUATION";

    if (trendContinuation) {
      return {
        // Trend-continuation is managed as one runner instead of
        // mechanically scalping out at TP1/TP2/TP3.
        partialTargets: [],
        moveStopToBreakEvenAtR: config.breakEvenAtR,
        trailingStop: {
          enabled: true,
          startAtR: config.trailingStartAtR,
          mode: "TREND_STRUCTURE",
          atrMultiple: TREND_ATR_FALLBACK_MULTIPLE,
          neverWidenStop: true,
          activateAtProfitPrice:
            TREND_TRAILING_ACTIVATE_PRICE,
          structureTrailAtProfitPrice:
            TREND_STRUCTURE_TRAIL_PRICE,
          positiveLockPrice:
            TREND_POSITIVE_LOCK_PRICE,
          swingBufferAtrMultiple:
            TREND_SWING_BUFFER_ATR,
          minimumDistanceAtrMultiple:
            TREND_MIN_DISTANCE_ATR,
        },
        maximumHoldingMinutes,
        cancelIfNotFilledAfterMinutes,
        hardInvalidationPrice: order.stopLoss,
        timeStopAt:
          generatedAt +
          maximumHoldingMinutes * 60_000,
        trendHoldUntilStructureBreak: true,
      };
    }

    const rangeMeanReversion =
      candidate.strategyId === "RANGE_MEAN_REVERSION";

    if (rangeMeanReversion) {
      return {
        // Sideway trades are finite mean-reversion trades. Keep the
        // planned scale-out targets and do not trail behind price; an ATR
        // trail can turn a range scalp into unintended trend-following.
        partialTargets:
          levels.partialTargets.map(
            (target) => ({ ...target }),
          ),
        moveStopToBreakEvenAtR: config.breakEvenAtR,
        trailingStop: {
          enabled: false,
          startAtR: config.trailingStartAtR,
          mode: "ATR",
          atrMultiple: config.trailingAtrMultiple,
          neverWidenStop: true,
        },
        maximumHoldingMinutes,
        cancelIfNotFilledAfterMinutes,
        hardInvalidationPrice: order.stopLoss,
        timeStopAt:
          generatedAt +
          maximumHoldingMinutes * 60_000,
      };
    }

    // Legacy compatibility branch for any explicitly supplied
    // non-trend/non-range strategy module.
    return {
      partialTargets:
        levels.partialTargets.map(
          (target) => ({ ...target }),
        ),
      moveStopToBreakEvenAtR: config.breakEvenAtR,
      trailingStop: {
        enabled: true,
        startAtR: config.trailingStartAtR,
        mode: "ATR",
        atrMultiple: config.trailingAtrMultiple,
        neverWidenStop: true,
      },
      maximumHoldingMinutes,
      cancelIfNotFilledAfterMinutes,
      hardInvalidationPrice: order.stopLoss,
      timeStopAt:
        generatedAt +
        maximumHoldingMinutes * 60_000,
    };
  }
}
