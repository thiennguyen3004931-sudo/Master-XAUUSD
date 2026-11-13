import type { Candle } from "@xauusd/market-data";
import type { VolumeProfileConfig } from "../config/AnalysisConfig";
import type {
  VolumeProfile,
  VolumeProfileNode,
} from "../models/VolumeProfile";

export class VolumeProfileAnalyzer {
  readonly name = "VolumeProfileAnalyzer";

  analyze(
    candles: readonly Candle[],
    config: VolumeProfileConfig,
  ): VolumeProfile {
    const recent = candles.slice(-Math.max(1, config.lookback));
    const createdAt = recent.at(-1)?.closeTime ?? Date.now();

    if (recent.length === 0) {
      return {
        poc: 0,
        hvn: [],
        lvn: [],
        nodes: [],
        rangeLow: 0,
        rangeHigh: 0,
        totalVolume: 0,
        lookback: 0,
        createdAt,
      };
    }

    const rangeLow = Math.min(...recent.map((candle) => candle.low));
    const rangeHigh = Math.max(...recent.map((candle) => candle.high));
    const range = rangeHigh - rangeLow;
    const binCount = Math.max(8, Math.round(config.bins));

    if (!(range > 0)) {
      const totalVolume = recent.reduce(
        (sum, candle) => sum + Math.max(0, candle.volume),
        0,
      );

      return {
        poc: recent.at(-1)!.close,
        hvn: [],
        lvn: [],
        nodes: [],
        rangeLow,
        rangeHigh,
        totalVolume,
        lookback: recent.length,
        createdAt,
      };
    }

    const binSize = range / binCount;
    const volumes = Array.from({ length: binCount }, () => 0);

    // Candle-volume approximation: allocate each candle's reported volume
    // to its typical-price bin. This is intentionally deterministic and
    // does not pretend to be broker tick-by-price history.
    for (const candle of recent) {
      const typicalPrice =
        (candle.high + candle.low + candle.close) / 3;

      const rawIndex = Math.floor(
        (typicalPrice - rangeLow) / binSize,
      );

      const index = Math.max(
        0,
        Math.min(binCount - 1, rawIndex),
      );

      volumes[index] =
        (volumes[index] ?? 0) + Math.max(0, candle.volume);
    }

    const totalVolume = volumes.reduce((sum, value) => sum + value, 0);

    const nodes: VolumeProfileNode[] = volumes.map(
      (volume, index) => {
        const low = rangeLow + index * binSize;
        const high = index === binCount - 1
          ? rangeHigh
          : low + binSize;

        return {
          low,
          high,
          price: (low + high) / 2,
          volume,
          share: totalVolume > 0 ? volume / totalVolume : 0,
        };
      },
    );

    const pocNode = nodes.reduce(
      (best, node) => node.volume > best.volume ? node : best,
      nodes[0]!,
    );

    const sortedVolumes = [...volumes].sort((a, b) => a - b);

    const percentile = (value: number): number => {
      const clamped = Math.max(0, Math.min(1, value));
      const index = Math.min(
        sortedVolumes.length - 1,
        Math.max(
          0,
          Math.round(clamped * (sortedVolumes.length - 1)),
        ),
      );

      return sortedVolumes[index] ?? 0;
    };

    const highThreshold = percentile(config.highVolumePercentile);
    const lowThreshold = percentile(config.lowVolumePercentile);

    return {
      poc: pocNode.price,
      hvn: nodes.filter(
        (node) => node.volume > 0 && node.volume >= highThreshold,
      ),
      lvn: nodes.filter(
        (node) => node.volume <= lowThreshold,
      ),
      nodes,
      rangeLow,
      rangeHigh,
      totalVolume,
      lookback: recent.length,
      createdAt,
    };
  }
}