import type { ICommissionModel } from "../contracts";
import type { FillCostContext } from "../models";
import { NumberUtils } from "../utils";

export class PercentageCommissionModel
  implements ICommissionModel
{
  constructor(private readonly ratePercent: number) {
    if (
      !Number.isFinite(ratePercent) ||
      ratePercent < 0
    ) {
      throw new RangeError(
        "ratePercent must be non-negative.",
      );
    }
  }

  calculate(context: FillCostContext): number {
    const notional =
      context.referencePrice *
      context.volume *
      context.contractSize;
    return NumberUtils.round(
      notional * (this.ratePercent / 100),
    );
  }
}
