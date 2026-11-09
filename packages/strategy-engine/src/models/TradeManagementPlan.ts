import type { PartialTarget } from "@xauusd/signal-engine";
import type { TrailingStopPlan } from "./TrailingStopPlan";

export interface TradeManagementPlan {
  partialTargets: PartialTarget[];
  moveStopToBreakEvenAtR: number;
  trailingStop: TrailingStopPlan;
  maximumHoldingMinutes: number;
  cancelIfNotFilledAfterMinutes: number;
  hardInvalidationPrice: number;
  timeStopAt: number;

  /**
   * When true, the time stop may be deferred only while a fresh
   * runtime trend-structure snapshot explicitly confirms that the
   * trend remains valid and unbroken.
   */
  trendHoldUntilStructureBreak?: boolean;
}