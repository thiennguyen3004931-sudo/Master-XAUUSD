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

function makeTick(timestampMs: number, bid: number, ask: number, verifiedSource = true): BrokerTick {
  return { timestampMs, bid, ask, verifiedSource };
}

describe("BrokerFaithfulStopOutReplay (G3 #52)", () => {
  it("refuses output and keeps all fidelity flags false when tick path or contract is unverified", () => {
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
    expect(noTicks.fidelity.tickOrderedBidAskVerified).toBe(false);

    const outOfOrder = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: [makeTick(2000, 2000, 2000.2), makeTick(1000, 2000, 2000.2)],
      orders: [],
      contract: BASE_CONTRACT,
    });
    expect(outOfOrder.ok).toBe(false);
    expect(outOfOrder.rejectionReason).toBe("TICK_PATH_UNVERIFIED");

    const unverifiedContract = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: validTicks,
      orders: [],
      contract: { ...BASE_CONTRACT, contractVerified: false },
    });
    expect(unverifiedContract.ok).toBe(false);
    expect(unverifiedContract.rejectionReason).toBe("BROKER_CONTRACT_UNVERIFIED");

    const unverifiedStopOrder = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: validTicks,
      orders: [],
      contract: { ...BASE_CONTRACT, liquidationOrderVerified: false },
    });
    expect(unverifiedStopOrder.ok).toBe(false);
    expect(unverifiedStopOrder.rejectionReason).toBe("STOP_OUT_ORDER_UNVERIFIED");
  });

  it("fills SL price gaps at actual gapped Bid/Ask tick rather than fabricated SL price", () => {
    const ticks = [
      makeTick(1000, 2000.0, 2000.2),
      makeTick(2000, 1985.0, 1985.2),
    ];
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks,
      orders: [
        {
          id: "ord-gap",
          side: "BUY",
          volume: 0.01,
          submittedAtMs: 1000,
          stopLoss: 1994.0,
        },
      ],
      contract: BASE_CONTRACT,
    });

    expect(res.ok).toBe(true);
    expect(res.fidelity.brokerStopOutExecutionVerified).toBe(false);
    expect(res.fidelity.tickOrderedBidAskVerified).toBe(true);
    const slExit = res.ledger.find((e) => e.eventType === "SL_EXIT");
    expect(slExit).toBeDefined();
    expect(slExit!.executionPrice).toBe(1985.0);
    expect(slExit!.grossPnl).toBe(-15.2);
    expect(res.totalCommissions).toBe(0.07);
    expect(res.totalSlippage).toBe(0.03);
    expect(res.finalBalance).toBe(984.7);
  });

  it("performs partial liquidation of DCA positions largest-loss-first until margin recovers above stop-out", () => {
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
        { id: "layer-2-dca", side: "BUY", volume: 0.1, submittedAtMs: 2000, isDcaLayer: true },
      ],
      contract: {
        ...BASE_CONTRACT,
        commissionPerLotRoundTrip: 0,
        slippagePerLotRoundTrip: 0,
      },
    });

    expect(res.ok).toBe(true);
    expect(res.marginCallTriggered).toBe(true);
    expect(res.stopOutTriggered).toBe(true);
    expect(res.liquidatedOrderIds).toEqual(["layer-2-dca"]);
    expect(res.remainingOpenPositions.map((p) => p.id)).toEqual(["layer-1"]);
  });

  it("enforces zero lookahead and keeps brokerTradingCostsVerified false when costsVerified is false", () => {
    const ticks = [
      makeTick(1000, 2000.0, 2000.2),
      makeTick(2000, 2010.0, 2010.2),
    ];
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks,
      orders: [
        {
          id: "causal-later",
          side: "BUY",
          volume: 0.01,
          submittedAtMs: 2000,
        },
      ],
      contract: { ...BASE_CONTRACT, costsVerified: false },
    });

    expect(res.ok).toBe(true);
    expect(res.fidelity.brokerTradingCostsVerified).toBe(false);
    expect(res.ledger[0]!.timestampMs).toBe(2000);
    expect(res.ledger[0]!.executionPrice).toBe(2010.2);
  });
  it("refuses NETTING rather than pretending that opposite orders are broker rejected", () => {
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 1000,
      ticks: [makeTick(1000, 2000, 2000.2)],
      orders: [{ id: "net-1", side: "BUY", volume: 0.1, submittedAtMs: 1000 }],
      contract: { ...BASE_CONTRACT, accountMode: "NETTING" },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectionReason).toBe("NETTING_REPLAY_NOT_IMPLEMENTED");
    expect(res.fidelity.brokerStopOutExecutionVerified).toBe(false);
  });

  it("rejects duplicate IDs, invalid stops and missing order inventory instead of silently skipping", () => {
    const good = { id: "duplicate", side: "BUY" as const, volume: 0.1, submittedAtMs: 1000 };
    const base = { initialBalance: 1000, ticks: [makeTick(1000, 2000, 2000.2)], contract: BASE_CONTRACT };
    expect(runBrokerFaithfulStopOutReplay({ ...base, orders: [good, { ...good }] }).rejectionReason)
      .toBe("ORDER_INTENT_INVALID");
    expect(runBrokerFaithfulStopOutReplay({ ...base, orders: [{ ...good, stopLoss: -5 }] }).rejectionReason)
      .toBe("ORDER_INTENT_INVALID");
    expect(runBrokerFaithfulStopOutReplay({ ...base, orders: null as unknown as typeof good[] }).rejectionReason)
      .toBe("ORDER_INTENTS_UNVERIFIED");
  });

  it("orders competing same-tick entries by submission timestamp, not caller array order", () => {
    const res = runBrokerFaithfulStopOutReplay({
      initialBalance: 500,
      ticks: [makeTick(2000, 2000, 2000)],
      orders: [
        { id: "later", side: "BUY", volume: 0.2, submittedAtMs: 1500 },
        { id: "earlier", side: "BUY", volume: 0.2, submittedAtMs: 1000 },
      ],
      contract: { ...BASE_CONTRACT, commissionPerLotRoundTrip: 0, slippagePerLotRoundTrip: 0 },
    });
    expect(res.ok).toBe(true);
    expect(res.ledger.filter(e => e.eventType === "ENTRY_FILL").map(e => e.orderId))
      .toEqual(["earlier"]);
    expect(res.rejectedOrderIds).toEqual(["later"]);
    expect(res.fidelity.brokerStopOutExecutionVerified).toBe(false);
  });

});
