import type { ExecutionEngineConfig } from "./ExecutionEngineConfig";

export const defaultExecutionEngineConfig: ExecutionEngineConfig = {
  maxQuoteAgeMs: 5_000,
  maxSlippageTicks: 50,
  maxSpreadMultiplier: 1,
  planExpiryGraceMs: 0,
  idempotencyTtlMs: 86_400_000,
  maxExecutionsPerMinute: 10,
  minimumStopDistanceTicks: 10,
  minimumTargetDistanceTicks: 10,
  breakEvenOffsetTicks: 1,
  minimumStopImprovementTicks: 2,
  managementCommandTtlMs: 30_000,
  failClosedOnAdapterError: true,
};
