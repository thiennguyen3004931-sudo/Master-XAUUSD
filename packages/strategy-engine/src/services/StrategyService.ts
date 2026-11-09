import type { IStrategyEngine } from "../contracts";
import type { StrategyContext, StrategyEvaluation } from "../models";
import { StrategyPipeline } from "../pipeline";

export class StrategyService {
  constructor(
    private readonly engine: IStrategyEngine = new StrategyPipeline(),
  ) {}

  evaluate(context: StrategyContext): StrategyEvaluation {
    return this.engine.evaluate(context);
  }
}
