import type { SupplyDemandZone } from "@xauusd/analysis-engine";

export interface SupplyDemandRange {
  demand: SupplyDemandZone;
  supply: SupplyDemandZone;
  lowerBoundary: number;
  upperBoundary: number;
  width: number;
  position: number;
  quality: number;
}

const MIN_ZONE_STRENGTH = 3;

export class RangeBoundaryUtils {
  static find(
    close: number,
    zones: readonly SupplyDemandZone[] | undefined,
  ): SupplyDemandRange | null {
    if (!zones?.length) return null;

    const active = zones.filter(
      (zone) => zone.active && zone.strength >= MIN_ZONE_STRENGTH,
    );
    const demands = active.filter(
      (zone) => zone.type === "DEMAND" && zone.low <= close,
    );
    const supplies = active.filter(
      (zone) => zone.type === "SUPPLY" && zone.high >= close,
    );

    let best: SupplyDemandRange | null = null;

    for (const demand of demands) {
      for (const supply of supplies) {
        const lowerBoundary = demand.high;
        const upperBoundary = supply.low;
        const width = upperBoundary - lowerBoundary;

        if (width <= 0 || close < demand.low || close > supply.high) {
          continue;
        }

        const position = Math.max(
          0,
          Math.min(1, (close - lowerBoundary) / width),
        );
        const touchBonus = (demand.touched ? 0.5 : 0) + (supply.touched ? 0.5 : 0);
        const quality = demand.strength + supply.strength + touchBonus;
        const candidate: SupplyDemandRange = {
          demand,
          supply,
          lowerBoundary,
          upperBoundary,
          width,
          position,
          quality,
        };

        if (
          !best ||
          candidate.quality > best.quality ||
          (candidate.quality === best.quality && candidate.width < best.width)
        ) {
          best = candidate;
        }
      }
    }

    return best;
  }

  static isNearDemand(range: SupplyDemandRange, close: number): boolean {
    return close <= range.demand.high || range.position <= 0.3;
  }

  static isNearSupply(range: SupplyDemandRange, close: number): boolean {
    return close >= range.supply.low || range.position >= 0.7;
  }
}
