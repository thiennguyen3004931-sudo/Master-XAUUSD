import type { RiskResult } from "../models/RiskResult";

export interface RiskRule<TContext, TResult = RiskResult> {
  readonly name: string;
  evaluate(context: TContext): TResult | Promise<TResult>;
}
