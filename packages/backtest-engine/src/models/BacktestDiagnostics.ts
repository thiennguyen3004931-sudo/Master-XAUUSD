/**
 * The candle engine cannot infer broker liquidation or market-data provenance.
 * These fields are FALSE even when a cost model was explicitly injected.
 * A future broker-validated simulation requires a separate reviewed contract.
 */
export interface BacktestBrokerFidelity {
  scope: "CANDLE_SIMULATION_NOT_BROKER_VERIFIED";
  brokerStopOutExecutionVerified: false;
  stopOutLiquidationSimulated: false;
  intrabarMarginStressSimulated: false;
  tickOrderedBidAskVerified: false;
  brokerTradingCostsVerified: false;
  commissionModelSource: "DEFAULT_ZERO_COMMISSION" | "INJECTED_MODEL_UNVERIFIED";
  slippageModelSource: "DEFAULT_ZERO_SLIPPAGE" | "INJECTED_MODEL_UNVERIFIED";
  intrabarOrderingAssumption: string;
}

export interface BacktestDiagnostics {
  warnings: string[];
  candlesProcessed: number;
  strategyEvaluations: number;
  executablePlans: number;
  entriesFilled: number;
  pendingOrdersExpired: number;
  plansSkippedByCapacity: number;
  invalidStrategyPlans: number;
  /** Always populated by BacktestEngine, optional for older report producers. */
  brokerFidelity?: BacktestBrokerFidelity;
}
