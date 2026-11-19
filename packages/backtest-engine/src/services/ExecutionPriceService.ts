import { OrderSide } from "@xauusd/types";
import type {
  ICommissionModel,
  ISlippageModel,
} from "../contracts";
import type {
  BacktestFill,
  FillCostContext,
  FillIntent,
} from "../models";
import { NumberUtils } from "../utils";

export class ExecutionPriceService {
  constructor(
    private readonly commissionModel: ICommissionModel,
    private readonly slippageModel: ISlippageModel,
  ) {}

  createFill(
    symbol: string,
    transactionSide: OrderSide,
    intent: FillIntent,
    referencePrice: number,
    volume: number,
    spread: number,
    tickSize: number,
    contractSize: number,
    timestamp: number,
    priceDigits: number,
  ): BacktestFill {
    const context: FillCostContext = {
      symbol,
      transactionSide,
      intent,
      referencePrice,
      volume,
      tickSize,
      contractSize,
      timestamp,
    };
    const halfSpread = spread / 2;
    const slippage =
      this.slippageModel.calculatePriceDistance(context);
    const direction =
      transactionSide === OrderSide.BUY ? 1 : -1;
    const fillPrice = NumberUtils.round(
      referencePrice +
        direction * (halfSpread + slippage),
      priceDigits,
    );

    return {
      transactionSide,
      intent,
      referencePrice,
      fillPrice,
      volume,
      spreadCostPerUnit: halfSpread,
      slippagePerUnit: slippage,
      commission: this.commissionModel.calculate(context),
      timestamp,
    };
  }
}
