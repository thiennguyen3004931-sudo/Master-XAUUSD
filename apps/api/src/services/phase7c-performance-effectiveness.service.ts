export * from "./phase7c-performance-effectiveness-core.service";

import {
  getPhase7CPerformanceEffectivenessSnapshot as getPhase7CPerformanceEffectivenessSnapshotCore,
  type Phase7CPerformanceEffectivenessQuery,
} from "./phase7c-performance-effectiveness-core.service";
import { runPhase7CSingleFlight } from "./phase7c-single-flight";

const performanceEffectivenessInFlight = new Map<string, Promise<unknown>>();

export function getPhase7CPerformanceEffectivenessSnapshot(
  query: Phase7CPerformanceEffectivenessQuery = {},
) {
  const days = query.days ?? 90;
  const symbol = query.symbol?.trim().toUpperCase() || "XAUUSD";
  const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 100)));
  const key = JSON.stringify([days, symbol, limit]);
  return runPhase7CSingleFlight(performanceEffectivenessInFlight, key, () =>
    getPhase7CPerformanceEffectivenessSnapshotCore(query),
  );
}
