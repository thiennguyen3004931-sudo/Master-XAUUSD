import { SwingType, type SwingPoint } from "@xauusd/types";
import { NumberUtils } from "../utils/NumberUtils";

export interface EqualHighLowResult {
  equalHighs: SwingPoint[];
  equalLows: SwingPoint[];
}

export class EqualHighLowDetector {
  readonly name = "EqualHighLowDetector";

  detect(
    swings: readonly SwingPoint[],
    tolerancePercent: number,
  ): EqualHighLowResult {
    if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0) {
      throw new RangeError("tolerancePercent must be non-negative");
    }

    return {
      equalHighs: this.findEqualLevels(
        swings.filter((swing) => swing.type === SwingType.High),
        tolerancePercent,
      ),
      equalLows: this.findEqualLevels(
        swings.filter((swing) => swing.type === SwingType.Low),
        tolerancePercent,
      ),
    };
  }

  private findEqualLevels(
    swings: readonly SwingPoint[],
    tolerancePercent: number,
  ): SwingPoint[] {
    const matched = new Map<number, SwingPoint>();

    for (let leftIndex = 0; leftIndex < swings.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < swings.length;
        rightIndex += 1
      ) {
        const left = swings[leftIndex]!;
        const right = swings[rightIndex]!;

        if (
          NumberUtils.percentageDifference(left.price, right.price) <=
          tolerancePercent
        ) {
          matched.set(left.index, left);
          matched.set(right.index, right);
        }
      }
    }

    return [...matched.values()].sort((left, right) => left.index - right.index);
  }
}
