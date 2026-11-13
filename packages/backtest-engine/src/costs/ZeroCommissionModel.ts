import type { ICommissionModel } from "../contracts";
import type { FillCostContext } from "../models";

export class ZeroCommissionModel implements ICommissionModel {
  calculate(_context: FillCostContext): number {
    return 0;
  }
}
