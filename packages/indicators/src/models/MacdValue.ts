import type { NullableNumber } from "./NullableNumber";

export interface MacdValue {
  macd: NullableNumber;
  signal: NullableNumber;
  histogram: NullableNumber;
}
