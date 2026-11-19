import type {
  DrawdownPoint,
  EquityPoint,
} from "../models";
import { NumberUtils } from "../utils";

export class DrawdownService {
  calculate(
    equityCurve: readonly EquityPoint[],
  ): DrawdownPoint[] {
    let peak = 0;

    return equityCurve.map((point) => {
      peak = Math.max(peak, point.equity);
      const drawdownAmount = Math.max(0, peak - point.equity);
      const drawdownPercent =
        peak > 0 ? (drawdownAmount / peak) * 100 : 0;

      return {
        timestamp: point.timestamp,
        peakEquity: NumberUtils.round(peak),
        equity: point.equity,
        drawdownAmount: NumberUtils.round(drawdownAmount),
        drawdownPercent: NumberUtils.round(drawdownPercent),
      };
    });
  }
}
