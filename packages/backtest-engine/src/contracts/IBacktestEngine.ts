import type {
  BacktestRequest,
  BacktestResult,
} from "../models";

export interface IBacktestEngine {
  run(request: BacktestRequest): Promise<BacktestResult>;
}
