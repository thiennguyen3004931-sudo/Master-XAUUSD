import { describe, expect, it } from "vitest";
import {
  runBrokerFaithfulStopOutReplay,
  type BrokerMarginContract,
  type BrokerTick,
} from "../src";

const BASE_CONTRACT: BrokerMarginContract = {
  accountMode: "HEDGING",
  leverage: 100,
  contractSize: 100,
  marginCallLevelPct: 100,
  stopOutLevelPct: 50,
  liquidationOrder: "LARGEST_LOSS_FIRST",
  commissionPerLotRoundTrip: 7,
  slippagePerLotRoundTrip: 3,
  contractVerified: true,
  liquidationOrderVerified: true,
  costsVerified: true,
};

function makeTick(
  timestampMs: number,
  bid: number,
  ask: number,
  verifiedSource = true
): BrokerTick {
  return { timestampMs, bid, ask, verifiedSource };
}

describe("BrokerFaithfulStopOutReplay (G3 #52)", () => {
  it("refuses output when tick path, contract, liquidation order, or NETTING mode is unverified", () => {
    const validTicks = [makeTick(1000, 2000, 2000.2)];

    const noTicks = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: [],
      orders: [],
      contract: BASE_CONTRACT,
    });
    expect(noTicks.ok).toBe(false);
    expect(noTicks.rejectionReason).toBe("TICK_PATH_UNVERIFIED");
    expect(noTicks.fidelity.brokerStopOutExecutionVerified).toBe(false);

    const netting = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: validTicks,
      orders: [],
      contract: { ...BASE_CONTRACT, accountMode: "NETTING" },
    });
    expect(netting.ok).toBe(false);
    expect(netting.rejectionReason).toBe("NETTING_REPLAY_NOT_IMPLEMENTED");

    const unverifiedContract = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: validTicks,
      orders: [],
      contract: { ...BASE_CONTRACT, contractVerified: false },
    });
    expect(unverifiedContract.ok).toBe(false);
    expect(unverifiedContract.rejectionReason).toBe("BROKER_CONTRACT_UNVERIFIED");

    const unverifiedOrder = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: validTicks,
      orders: [],
      contract: { ...BASE_CONTRACT, liquidationOrderVerified: false },
    });
    expect(unverifiedOrder.ok).toBe(false);
    expect(unverifiedOrder.rejectionReason).toBe("STOP_OUT_ORDER_UNVERIFIED");
  });

  it("refuses immediate spread-insolvent entry and discloses assumed-contract scope", () => {
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 201,
      ticks: [makeTick(1000, 1989.0, 2000.0)],
      orders: [{ id: "buy-spread-insolvent", side: "BUY", volume: 0.1, submittedAtMs: 1000 }],
      contract: {
        ...BASE_CONTRACT,
        commissionPerLotRoundTrip: 0,
        slippagePerLotRoundTrip: 0,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.fidelity.scope).toBe("ASSUMED_CONTRACT_TICK_SCENARIO_NOT_BROKER_ATTESTED");
    expect(res.fidelity.brokerStopOutExecutionVerified).toBe(false);
    expect(res.fidelity.callerSuppliedContractAssumed).toBe(true);
    expect(res.fidelity.hedgedMarginReliefVerified).toBe(false);
    expect(res.rejectedOrderIds).toEqual(["buy-spread-insolvent"]);
    expect(res.remainingOpenPositions).toEqual([]);
  });

  it("rejects invalid SL/TP direction at intended fill time instead of instant SL_EXIT", () => {
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: [makeTick(1000, 2000.0, 2000.2)],
      orders: [
        { id: "bad-buy-sl", side: "BUY", volume: 0.01, submittedAtMs: 1000, stopLoss: 2005.0 },
        { id: "bad-buy-tp", side: "BUY", volume: 0.01, submittedAtMs: 1000, takeProfit: 1995.0 },
        { id: "bad-sell-sl", side: "SELL", volume: 0.01, submittedAtMs: 1000, stopLoss: 1995.0 },
        { id: "bad-sell-tp", side: "SELL", volume: 0.01, submittedAtMs: 1000, takeProfit: 2005.0 },
      ],
      contract: BASE_CONTRACT,
    });
    expect(res.ok).toBe(true);
    expect(res.rejectedOrderIds).toEqual([
      "bad-buy-sl",
      "bad-buy-tp",
      "bad-sell-sl",
      "bad-sell-tp",
    ]);
    expect(res.ledger).toEqual([]);
  });

  it("processes existing SL exit and stop-out liquidation BEFORE admitting same-tick new orders", () => {
    const ticks = [
      makeTick(1000, 2000.0, 2000.2),
      makeTick(2000, 1985.0, 1985.2),
    ];
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks,
      orders: [
        { id: "buy-1", side: "BUY", volume: 0.01, submittedAtMs: 1000, stopLoss: 1994.0 },
        { id: "buy-2", side: "BUY", volume: 0.01, submittedAtMs: 2000, stopLoss: 1978.0 },
      ],
      contract: BASE_CONTRACT,
    });
    expect(res.ok).toBe(true);
    const eventOrder = res.ledger.map((e) => `${e.eventType}:${e.orderId}`);
    expect(eventOrder).toEqual([
      "ENTRY_FILL:buy-1",
      "SL_EXIT:buy-1",
      "ENTRY_FILL:buy-2",
    ]);
  });

  it("rejects opposing hedge leg and supports SELL + DCA partial stop-out liquidation", () => {
    const ticks = [
      makeTick(1000, 2000.0, 2000.0),
      makeTick(2000, 2005.0, 2005.0),
      makeTick(3000, 1991.5, 1991.7),
    ];
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 400,
      ticks,
      orders: [
        { id: "layer-1", side: "BUY", volume: 0.1, submittedAtMs: 1000, isDcaLayer: false },
        { id: "opposing-sell", side: "SELL", volume: 0.05, submittedAtMs: 1000 },
        { id: "layer-2-dca", side: "BUY", volume: 0.1, submittedAtMs: 2000, isDcaLayer: true },
      ],
      contract: {
        ...BASE_CONTRACT,
        commissionPerLotRoundTrip: 0,
        slippagePerLotRoundTrip: 0,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.rejectedOrderIds).toEqual(["opposing-sell"]);
    expect(res.stopOutTriggered).toBe(true);
    expect(res.liquidatedOrderIds).toEqual(["layer-2-dca"]);
    expect(res.remainingOpenPositions.map((p) => p.id)).toEqual(["layer-1"]);

    const sellGap = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: [makeTick(1000, 2000.0, 2000.2), makeTick(2000, 2014.8, 2015.0)],
      orders: [{ id: "sell-1", side: "SELL", volume: 0.01, submittedAtMs: 1000, stopLoss: 2007.0 }],
      contract: BASE_CONTRACT,
    });
    expect(sellGap.ok).toBe(true);
    const sellExit = sellGap.ledger.find((e) => e.eventType === "SL_EXIT");
    expect(sellExit!.executionPrice).toBe(2015.0);
    expect(sellExit!.grossPnl).toBe(-15.0);
  });
});
