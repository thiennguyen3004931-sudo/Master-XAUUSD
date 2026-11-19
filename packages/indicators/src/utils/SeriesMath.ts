import type { NullableNumber } from "../models/NullableNumber";
import { NumberUtils } from "./NumberUtils";

export const simpleMovingAverage = (
  values: readonly number[],
  period: number,
): NullableNumber[] => {
  NumberUtils.assertPositiveInteger(period, "period");
  const result: NullableNumber[] = Array(values.length).fill(null);
  let rollingSum = 0;

  for (let index = 0; index < values.length; index += 1) {
    rollingSum += values[index]!;

    if (index >= period) {
      rollingSum -= values[index - period]!;
    }

    if (index >= period - 1) {
      result[index] = rollingSum / period;
    }
  }

  return result;
};

export const exponentialMovingAverage = (
  values: readonly number[],
  period: number,
): NullableNumber[] => {
  NumberUtils.assertPositiveInteger(period, "period");
  const result: NullableNumber[] = Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  const multiplier = 2 / (period + 1);
  let previous = NumberUtils.mean(values.slice(0, period));
  result[period - 1] = previous;

  for (let index = period; index < values.length; index += 1) {
    previous = (values[index]! - previous) * multiplier + previous;
    result[index] = previous;
  }

  return result;
};

export const exponentialMovingAverageNullable = (
  values: readonly NullableNumber[],
  period: number,
): NullableNumber[] => {
  NumberUtils.assertPositiveInteger(period, "period");
  const result: NullableNumber[] = Array(values.length).fill(null);
  const seed: number[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === null) {
      continue;
    }

    if (previous === null) {
      seed.push(value);

      if (seed.length === period) {
        previous = NumberUtils.mean(seed);
        result[index] = previous;
      }

      continue;
    }

    previous = (value - previous) * multiplier + previous;
    result[index] = previous;
  }

  return result;
};

export const simpleMovingAverageNullable = (
  values: readonly NullableNumber[],
  period: number,
): NullableNumber[] => {
  NumberUtils.assertPositiveInteger(period, "period");
  const result: NullableNumber[] = Array(values.length).fill(null);
  const window: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === null) {
      window.length = 0;
      continue;
    }

    window.push(value);
    if (window.length > period) {
      window.shift();
    }

    if (window.length === period) {
      result[index] = NumberUtils.mean(window);
    }
  }

  return result;
};

export const wilderMovingAverage = (
  values: readonly number[],
  period: number,
): NullableNumber[] => {
  NumberUtils.assertPositiveInteger(period, "period");
  const result: NullableNumber[] = Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  let previous = NumberUtils.mean(values.slice(0, period));
  result[period - 1] = previous;

  for (let index = period; index < values.length; index += 1) {
    previous = ((previous * (period - 1)) + values[index]!) / period;
    result[index] = previous;
  }

  return result;
};
