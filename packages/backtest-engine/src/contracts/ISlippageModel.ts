import type { FillCostContext } from "../models";

export interface ISlippageModel {
  calculatePriceDistance(context: FillCostContext): number;
}
