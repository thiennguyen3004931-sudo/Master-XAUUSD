import type { ISlippageModel } from "../contracts";
import type { FillCostContext } from "../models";

export class ZeroSlippageModel implements ISlippageModel {
  calculatePriceDistance(_context: FillCostContext): number {
    return 0;
  }
}
