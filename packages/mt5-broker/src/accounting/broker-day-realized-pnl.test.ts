import { describe, expect, it } from "vitest";
import type { Mt5BridgeDeal } from "../models/Mt5BridgeDeal";
import {
  computeBrokerDayRealizedPnl,
  summarizeBrokerDayRealizedPnl,
} from "./broker-day-realized-pnl";

function deal(overrides: Partial<Mt5BridgeDeal> = {}): Mt5BridgeDeal {
  return {
    ticket: "1",
    orderId: "10",
    positionId: "100",
    symbol: "XAUUSD",
    side: "BUY",
    entry: "OUT",
    volume: 0.03,
    price: 3400,
    profit: 0,
    commission: 0,
    swap: 0,
    fee: 0,
    netPnl: 0,
    magic: 270715,
    comment: "phase7c",
    timestamp: 1787961600000,
    isTradingDeal: true,
    ...overrides,
  };
}

describe("computeBrokerDayRealizedPnl", () => {
  it("sums canonical netPnl only for trading deals owned by configured bot magics", () => {
    const deals = [
      deal({ ticket: "1", magic: 270715, netPnl: 10.25 }),
      deal({ ticket: "2", magic: 270714, netPnl: -2.5 }),
      deal({ ticket: "3", magic: 999999, netPnl: 100 }),
      deal({ ticket: "4", magic: 270715, isTradingDeal: false, netPnl: 50 }),
    ];

    expect(
      computeBrokerDayRealizedPnl(deals, new Set([270715, 270714])),
    ).toBeCloseTo(7.75, 10);
  });

  it("uses bridge netPnl as the accounting source instead of reconstructing profit components", () => {
    const deals = [
      deal({
        profit: 100,
        commission: -3,
        swap: -2,
        fee: -1,
        netPnl: 4.5,
      }),
    ];

    expect(computeBrokerDayRealizedPnl(deals, [270715])).toBe(4.5);
  });

  it("returns zero when the broker-day window contains no owned trading deals", () => {
    const deals = [
      deal({ magic: 999999, netPnl: 12 }),
      deal({ isTradingDeal: false, netPnl: -7 }),
    ];

    expect(computeBrokerDayRealizedPnl(deals, [270715, 270714])).toBe(0);
  });
});

describe("summarizeBrokerDayRealizedPnl", () => {
  it("returns one canonical owned-deal count together with the same daily net P&L", () => {
    const deals = [
      deal({ ticket: "1", magic: 270715, netPnl: 10.25 }),
      deal({ ticket: "2", magic: 270714, netPnl: -2.5 }),
      deal({ ticket: "3", magic: 999999, netPnl: 100 }),
      deal({ ticket: "4", magic: 270715, isTradingDeal: false, netPnl: 50 }),
    ];

    expect(summarizeBrokerDayRealizedPnl(deals, [270715, 270714])).toEqual({
      dealCount: 2,
      dailyNetPnl: 7.75,
    });
  });
});
