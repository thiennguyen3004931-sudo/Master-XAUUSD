import type { NullableNumber } from "./NullableNumber";

export interface BollingerBandsValue {
  middle: NullableNumber;
  upper: NullableNumber;
  lower: NullableNumber;
  bandwidth: NullableNumber;
  percentB: NullableNumber;
}
