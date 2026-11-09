import type { ICommissionModel } from "../contracts";
import type { FillCostContext } from "../models";
import { NumberUtils } from "../utils";

export class FixedCommissionPerLotModel
  implements ICommissionModel
{
  constructor(
    private readonly amountPerLotPerSide: number,
  ) {
    if (
      !Number.isFinite(amountPerLotPerSide) ||
      amountPerLotPerSide < 0
    ) {
      throw new RangeError(
        "amountPerLotPerSide must be non-negative.",
      );
    }
  }

  calculate(context: FillCostContext): number {
    return NumberUtils.round(
      context.volume * this.amountPerLotPerSide,
    );
  }
}
