import type {
  TradeManagementPlan,
} from "@xauusd/strategy-engine";

import type {
  PositionManagementContext,
} from "./PositionManagementContext";

const management = {} as TradeManagementPlan;

// Compile-time contract: SEMI must be able to reuse PositionManagementService
// without fabricating a StrategyPlan, selected strategy, signal, or pattern.
export const semiManagementOnlyPlan = {
  order: {
    symbol: "XAUUSD",
    stopLoss: 3594,
  },
  management,
} satisfies PositionManagementContext["plan"];
