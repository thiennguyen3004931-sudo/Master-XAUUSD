export * from "./phase7c-performance-intelligence-core.service";

import {
  getPhase7CPerformanceIntelligence as getPhase7CPerformanceIntelligenceCore,
} from "./phase7c-performance-intelligence-core.service";
import { runPhase7CSingleFlight } from "./phase7c-single-flight";

const performanceIntelligenceInFlight = new Map<string, Promise<unknown>>();

export function getPhase7CPerformanceIntelligence(days = 90, symbol = "XAUUSD") {
  const key = JSON.stringify([days, symbol]);
  return runPhase7CSingleFlight(performanceIntelligenceInFlight, key, () =>
    getPhase7CPerformanceIntelligenceCore(days, symbol),
  );
}
