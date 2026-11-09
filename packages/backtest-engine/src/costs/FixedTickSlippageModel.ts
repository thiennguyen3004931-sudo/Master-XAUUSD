import type { ISlippageModel } from "../contracts";
import type { FillCostContext } from "../models";

export class FixedTickSlippageModel
  implements ISlippageModel
{
  constructor(private readonly ticks: number) {
    if (!Number.isFinite(ticks) || ticks < 0) {
      throw new RangeError("ticks must be non-negative.");
    }
  }

  calculatePriceDistance(context: FillCostContext): number {
    return this.ticks * context.tickSize;
  }
}
