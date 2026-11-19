import type { Candle } from "@xauusd/market-data";
import type {
  BacktestPosition,
  BacktestPositionSnapshot,
  EquityPoint,
} from "../models";
import type { BacktestConfig } from "../config";
import { NumberUtils, TradeMath } from "../utils";

export class EquityCurveService {
  calculateUnrealized(
    positions: readonly BacktestPosition[],
    price: number,
    config: BacktestConfig,
  ): number {
    return NumberUtils.round(
      positions.reduce(
        (sum, position) =>
          sum +
          TradeMath.unrealizedPnl(
            position.side,
            position.entryPrice,
            price,
            position.remainingVolume,
            config.contractSize,
          ),
        0,
      ),
    );
  }

  createPoint(
    candle: Candle,
    balance: number,
    positions: readonly BacktestPosition[],
    config: BacktestConfig,
  ): EquityPoint {
    const unrealizedPnl = this.calculateUnrealized(
      positions,
      candle.close,
      config,
    );
    return {
      timestamp: candle.closeTime,
      balance: NumberUtils.round(balance),
      equity: NumberUtils.round(balance + unrealizedPnl),
      unrealizedPnl,
    };
  }

  snapshots(
    positions: readonly BacktestPosition[],
    currentPrice: number,
    config: BacktestConfig,
  ): BacktestPositionSnapshot[] {
    return positions.map((position) => ({
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      volume: position.remainingVolume,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      unrealizedPnl: TradeMath.unrealizedPnl(
        position.side,
        position.entryPrice,
        currentPrice,
        position.remainingVolume,
        config.contractSize,
      ),
    }));
  }
}
