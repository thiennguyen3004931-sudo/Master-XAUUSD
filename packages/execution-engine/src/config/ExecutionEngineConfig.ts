export interface ExecutionEngineConfig {
  maxQuoteAgeMs: number;
  maxSlippageTicks: number;
  maxSpreadMultiplier: number;
  planExpiryGraceMs: number;
  idempotencyTtlMs: number;
  maxExecutionsPerMinute: number;
  minimumStopDistanceTicks: number;
  minimumTargetDistanceTicks: number;
  breakEvenOffsetTicks: number;
  minimumStopImprovementTicks: number;
  managementCommandTtlMs: number;
  failClosedOnAdapterError: boolean;
}
