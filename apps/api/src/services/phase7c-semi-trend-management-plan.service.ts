import type { PositionManagementPlan } from "@xauusd/execution-engine";

import type { DurableSemiAdoptionState } from "./phase7c-semi-adoption-state.service";

const TREND_MAXIMUM_HOLDING_MINUTES = 480;
const TREND_BREAK_EVEN_AT_R = 1;
const TREND_TRAILING_START_AT_R = 1.5;
const TREND_TRAILING_ACTIVATE_PRICE = 6;
const TREND_STRUCTURE_TRAIL_PRICE = 10;
const TREND_POSITIVE_LOCK_PRICE = 0.5;
const TREND_SWING_BUFFER_ATR = 0.25;
const TREND_MIN_DISTANCE_ATR = 0.5;
const TREND_ATR_FALLBACK_MULTIPLE = 1.5;
const SEMI_PARTIAL_CLOSE_PRICE_GAIN = 10;
const SEMI_PARTIAL_CLOSE_PERCENT = 100 / 3;

export function createPhase7CSemiTrendManagementPlan(
  adoption: DurableSemiAdoptionState,
): PositionManagementPlan {
  if (
    adoption.protectionStatus !== "PROTECTED" &&
    adoption.protectionStatus !== "MANAGED"
  ) {
    throw new Error(
      `SEMI Trend management requires PROTECTED or MANAGED adoption; got ${adoption.protectionStatus}.`,
    );
  }

  if (
    adoption.symbol !== "XAUUSD" ||
    adoption.entrySource !== "MANUAL" ||
    adoption.managementStrategy !== "TREND"
  ) {
    throw new Error("SEMI Trend management requires a manual XAUUSD TREND adoption.");
  }

  if (
    !Number.isFinite(adoption.entry) ||
    adoption.entry <= 0 ||
    !Number.isFinite(adoption.tightestStopLoss) ||
    adoption.tightestStopLoss <= 0 ||
    !Number.isFinite(adoption.managementStartedAt) ||
    adoption.managementStartedAt <= 0
  ) {
    throw new Error("SEMI Trend management adoption contains invalid lifecycle/price state.");
  }

  const partialTargetPrice = adoption.side === "LONG"
    ? adoption.entry + SEMI_PARTIAL_CLOSE_PRICE_GAIN
    : adoption.entry - SEMI_PARTIAL_CLOSE_PRICE_GAIN;

  return {
    order: {
      symbol: "XAUUSD",
      stopLoss: adoption.tightestStopLoss,
    },
    management: {
      partialTargets: [
        {
          label: "TP1",
          price: partialTargetPrice,
          closePercent: SEMI_PARTIAL_CLOSE_PERCENT,
          rewardMultiple:
            SEMI_PARTIAL_CLOSE_PRICE_GAIN / adoption.initialStopDistance,
        },
      ],
      moveStopToBreakEvenAtR: TREND_BREAK_EVEN_AT_R,
      trailingStop: {
        enabled: true,
        startAtR: TREND_TRAILING_START_AT_R,
        mode: "TREND_STRUCTURE",
        atrMultiple: TREND_ATR_FALLBACK_MULTIPLE,
        neverWidenStop: true,
        activateAtProfitPrice: TREND_TRAILING_ACTIVATE_PRICE,
        structureTrailAtProfitPrice: TREND_STRUCTURE_TRAIL_PRICE,
        positiveLockPrice: TREND_POSITIVE_LOCK_PRICE,
        swingBufferAtrMultiple: TREND_SWING_BUFFER_ATR,
        minimumDistanceAtrMultiple: TREND_MIN_DISTANCE_ATR,
      },
      maximumHoldingMinutes: TREND_MAXIMUM_HOLDING_MINUTES,
      cancelIfNotFilledAfterMinutes: 60,
      hardInvalidationPrice: adoption.tightestStopLoss,
      timeStopAt:
        adoption.managementStartedAt +
        TREND_MAXIMUM_HOLDING_MINUTES * 60_000,
      trendHoldUntilStructureBreak: true,
    },
  };
}
