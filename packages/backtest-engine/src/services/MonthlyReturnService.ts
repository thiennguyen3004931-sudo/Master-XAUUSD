import type {
  EquityPoint,
  MonthlyReturn,
} from "../models";
import { NumberUtils } from "../utils";

export class MonthlyReturnService {
  calculate(
    equityCurve: readonly EquityPoint[],
  ): MonthlyReturn[] {
    const groups = new Map<string, EquityPoint[]>();

    for (const point of equityCurve) {
      const date = new Date(point.timestamp);
      const key = `${date.getUTCFullYear()}-${String(
        date.getUTCMonth() + 1,
      ).padStart(2, "0")}`;
      const group = groups.get(key) ?? [];
      group.push(point);
      groups.set(key, group);
    }

    return [...groups.entries()].map(([month, points]) => {
      const openingEquity = points[0]!.equity;
      const closingEquity = points[points.length - 1]!.equity;
      return {
        month,
        openingEquity,
        closingEquity,
        returnPercent:
          openingEquity > 0
            ? NumberUtils.round(
                ((closingEquity - openingEquity) /
                  openingEquity) *
                  100,
              )
            : 0,
      };
    });
  }
}
