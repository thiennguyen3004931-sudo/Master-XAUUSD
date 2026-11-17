import type { Candle } from "@xauusd/market-data";
import { SwingType, type LiquidityZone, type SwingPoint } from "@xauusd/types";
import { NumberUtils } from "../utils/NumberUtils";

interface Cluster {
  points: SwingPoint[];
  averagePrice: number;
}

export class LiquidityDetector {
  readonly name = "LiquidityDetector";

  detect(
    swings: readonly SwingPoint[],
    candles: readonly Candle[],
    tolerancePercent: number,
  ): LiquidityZone[] {
    if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0) {
      throw new RangeError("tolerancePercent must be non-negative");
    }

    const clusters = [
      ...this.cluster(
        swings.filter((swing) => swing.type === SwingType.High),
        tolerancePercent,
      ),
      ...this.cluster(
        swings.filter((swing) => swing.type === SwingType.Low),
        tolerancePercent,
      ),
    ];

    return clusters
      .filter((cluster) => cluster.points.length >= 2)
      .map((cluster) => this.toZone(cluster, candles, tolerancePercent))
      .sort((left, right) => right.strength - left.strength);
  }

  private cluster(
    swings: readonly SwingPoint[],
    tolerancePercent: number,
  ): Cluster[] {
    const clusters: Cluster[] = [];

    for (const swing of swings) {
      const existing = clusters.find(
        (cluster) =>
          NumberUtils.percentageDifference(
            cluster.averagePrice,
            swing.price,
          ) <= tolerancePercent,
      );

      if (existing) {
        existing.points.push(swing);
        existing.averagePrice =
          existing.points.reduce((sum, point) => sum + point.price, 0) /
          existing.points.length;
      } else {
        clusters.push({ points: [swing], averagePrice: swing.price });
      }
    }

    return clusters;
  }

  private toZone(
    cluster: Cluster,
    candles: readonly Candle[],
    tolerancePercent: number,
  ): LiquidityZone {
    const latestPoint = cluster.points.at(-1)!;
    const halfWidth = cluster.averagePrice * (tolerancePercent / 100);
    const laterCandles = candles.slice(latestPoint.index + 1);
    const highZone = latestPoint.type === SwingType.High;
    const touched = laterCandles.some((candle) =>
      highZone
        ? candle.high >= cluster.averagePrice
        : candle.low <= cluster.averagePrice,
    );

    return {
      id: `${highZone ? "BSL" : "SSL"}-${latestPoint.timestamp}`,
      price: cluster.averagePrice,
      upperBound: cluster.averagePrice + halfWidth,
      lowerBound: cluster.averagePrice - halfWidth,
      strength: Math.min(
        5,
        Math.max(
          1,
          Math.round(
            cluster.points.reduce((sum, point) => sum + point.strength, 0) /
              cluster.points.length,
          ),
        ),
      ),
      touched,
      createdAt: latestPoint.timestamp,
    };
  }
}
