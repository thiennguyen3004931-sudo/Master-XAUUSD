import type { FillCostContext } from "../models";

export interface ICommissionModel {
  calculate(context: FillCostContext): number;
}
