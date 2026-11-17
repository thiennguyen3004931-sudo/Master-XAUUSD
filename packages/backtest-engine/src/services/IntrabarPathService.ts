import type { Candle } from "@xauusd/market-data";
import type { IntrabarPriority } from "../config";
import type {
  BacktestPosition,
  IntrabarEvent,
} from "../models";
import { OrderSide } from "@xauusd/types";

export class IntrabarPathService {
  orderEvents(
    candle: Candle,
    position: BacktestPosition,
    events: readonly IntrabarEvent[],
    priority: IntrabarPriority,
  ): IntrabarEvent[] {
    const touched = events.filter((event) =>
      this.isTouched(candle, event.price),
    );

    if (priority === "STOP_FIRST") {
      return [...touched].sort((left, right) => {
        const leftProtective =
          left.type === "STOP" ||
          left.type === "HARD_INVALIDATION";
        const rightProtective =
          right.type === "STOP" ||
          right.type === "HARD_INVALIDATION";
        if (leftProtective !== rightProtective) {
          return leftProtective ? -1 : 1;
        }
        if (leftProtective && rightProtective) {
          const leftPriority = left.type === "STOP" ? 0 : 1;
          const rightPriority = right.type === "STOP" ? 0 : 1;
          return leftPriority - rightPriority;
        }
        return this.targetSort(position, left, right);
      });
    }

    if (priority === "TARGET_FIRST") {
      return [...touched].sort((left, right) => {
        const leftTarget = left.type === "TARGET";
        const rightTarget = right.type === "TARGET";
        if (leftTarget !== rightTarget) {
          return leftTarget ? -1 : 1;
        }
        if (!leftTarget && !rightTarget) {
          const leftPriority = left.type === "STOP" ? 0 : 1;
          const rightPriority = right.type === "STOP" ? 0 : 1;
          return leftPriority - rightPriority;
        }
        return this.targetSort(position, left, right);
      });
    }

    return this.orderByOhlcPath(candle, touched);
  }

  resolveReferencePrice(
    candle: Candle,
    position: BacktestPosition,
    event: IntrabarEvent,
  ): number {
    const isBuy = position.side === OrderSide.BUY;
    const isProtective =
      event.type === "STOP" ||
      event.type === "HARD_INVALIDATION";

    if (isBuy && isProtective && candle.open <= event.price) {
      return candle.open;
    }
    if (!isBuy && isProtective && candle.open >= event.price) {
      return candle.open;
    }
    if (isBuy && !isProtective && candle.open >= event.price) {
      return candle.open;
    }
    if (!isBuy && !isProtective && candle.open <= event.price) {
      return candle.open;
    }

    return event.price;
  }

  private orderByOhlcPath(
    candle: Candle,
    events: readonly IntrabarEvent[],
  ): IntrabarEvent[] {
    const points =
      candle.close >= candle.open
        ? [candle.open, candle.low, candle.high, candle.close]
        : [candle.open, candle.high, candle.low, candle.close];
    const ordered: IntrabarEvent[] = [];
    const emitted = new Set<string>();

    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index]!;
      const to = points[index + 1]!;
      const ascending = to >= from;
      const segmentEvents = events
        .filter(
          (event) =>
            !emitted.has(event.id) &&
            event.price >= Math.min(from, to) &&
            event.price <= Math.max(from, to),
        )
        .sort((left, right) =>
          ascending
            ? left.price - right.price
            : right.price - left.price,
        );

      for (const event of segmentEvents) {
        ordered.push(event);
        emitted.add(event.id);
      }
    }

    return ordered;
  }

  private targetSort(
    position: BacktestPosition,
    left: IntrabarEvent,
    right: IntrabarEvent,
  ): number {
    return position.side === OrderSide.BUY
      ? left.price - right.price
      : right.price - left.price;
  }

  private isTouched(candle: Candle, price: number): boolean {
    return candle.low <= price && candle.high >= price;
  }
}
