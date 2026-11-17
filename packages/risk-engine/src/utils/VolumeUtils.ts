import { NumberUtils } from "./NumberUtils";

export class VolumeUtils {
  static floorToStep(value: number, step: number, digits = 8): number {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
      return 0;
    }

    const steps = Math.floor((value + Number.EPSILON) / step);
    return NumberUtils.round(steps * step, digits);
  }
}
