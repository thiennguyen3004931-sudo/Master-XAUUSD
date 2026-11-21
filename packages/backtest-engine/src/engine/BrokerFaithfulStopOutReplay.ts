export type BrokerAccountMode = "HEDGING" | "NETTING";
export type StopOutLiquidationOrder = "LARGEST_LOSS_FIRST" | "FIFO";

export interface BrokerTick {
  timestampMs: number;
  bid: number;
  ask: number;
  verifiedSource: boolean;
}

export interface BrokerMarginContract {
  accountMode: BrokerAccountMode;
  leverage: number;
  contractSize: number;
  marginCallLevelPct: number;
  stopOutLevelPct: number;
  liquidationOrder: StopOutLiquidationOrder;
  commissionPerLotRoundTrip: number;
  slippagePerLotRoundTrip: number;
  contractVerified: boolean;
  liquidationOrderVerified: boolean;
  costsVerified: boolean;
}

export interface BrokerReplayOrderIntent {
  id: string;
  side: "BUY" | "SELL";
  volume: number;
  submittedAtMs: number;
  stopLoss?: number;
  takeProfit?: number;
  isDcaLayer?: boolean;
}

export interface BrokerReplayRequest {
  initialBalance: number;
  ticks: readonly BrokerTick[];
  orders: readonly BrokerReplayOrderIntent[];
  contract: Partial<BrokerMarginContract> | null | undefined;
}

export interface BrokerReplayFidelity {
  scope: "TICK_ORDERED_BROKER_CONTRACT_REPLAY" | "REFUSED_UNVERIFIED_INPUTS";
  brokerStopOutExecutionVerified: boolean;
  stopOutLiquidationSimulated: boolean;
  intrabarMarginStressSimulated: boolean;
  tickOrderedBidAskVerified: boolean;
  brokerTradingCostsVerified: boolean;
}

export interface CollateralLedgerEntry {
  timestampMs: number;
  eventType:
    | "ENTRY_FILL"
    | "SL_EXIT"
    | "TP_EXIT"
    | "STOP_OUT_LIQUIDATION"
    | "MARGIN_CALL_BREACH";
  orderId: string;
  side?: "BUY" | "SELL";
  volume?: number;
  executionPrice?: number;
  grossPnl: number;
  commissionFee: number;
  slippageFee: number;
  balanceAfter: number;
  equityAfter: number;
  usedMarginAfter: number;
  marginLevelPctAfter: number | null;
}

export interface OpenReplayPosition {
  id: string;
  side: "BUY" | "SELL";
  volume: number;
  entryPrice: number;
  openedAtMs: number;
  stopLoss?: number;
  takeProfit?: number;
  isDcaLayer: boolean;
  usedMargin: number;
}

export interface BrokerReplayResult {
  ok: boolean;
  rejectionReason?: string;
  fidelity: BrokerReplayFidelity;
  finalBalance: number;
  finalEquity: number;
  totalRealizedPnl: number;
  totalCommissions: number;
  totalSlippage: number;
  marginCallTriggered: boolean;
  stopOutTriggered: boolean;
  liquidatedOrderIds: string[];
  rejectedOrderIds: string[];
  remainingOpenPositions: OpenReplayPosition[];
  ledger: CollateralLedgerEntry[];
}

function isFinitePositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function refused(reason: string, initialBalance: number): BrokerReplayResult {
  const safeBal = isFinitePositive(initialBalance) ? initialBalance : 0;
  return {
    ok: false,
    rejectionReason: reason,
    fidelity: {
      scope: "REFUSED_UNVERIFIED_INPUTS",
      brokerStopOutExecutionVerified: false,
      stopOutLiquidationSimulated: false,
      intrabarMarginStressSimulated: false,
      tickOrderedBidAskVerified: false,
      brokerTradingCostsVerified: false,
    },
    finalBalance: safeBal,
    finalEquity: safeBal,
    totalRealizedPnl: 0,
    totalCommissions: 0,
    totalSlippage: 0,
    marginCallTriggered: false,
    stopOutTriggered: false,
    liquidatedOrderIds: [],
    rejectedOrderIds: [],
    remainingOpenPositions: [],
    ledger: [],
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function computePositionFloatingPnl(
  pos: OpenReplayPosition,
  tick: BrokerTick,
  contractSize: number
): number {
  const closePrice = pos.side === "BUY" ? tick.bid : tick.ask;
  const priceDiff =
    pos.side === "BUY" ? closePrice - pos.entryPrice : pos.entryPrice - closePrice;
  return priceDiff * pos.volume * contractSize;
}

export function runBrokerFaithfulStopOutReplay(
  request: BrokerReplayRequest
): BrokerReplayResult {
  if (!isFinitePositive(request.initialBalance)) {
    return refused("INVALID_INITIAL_BALANCE", 0);
  }
  const c = request.contract;
  if (!c || c.contractVerified !== true) {
    return refused("BROKER_CONTRACT_UNVERIFIED", request.initialBalance);
  }
  if (c.liquidationOrderVerified !== true) {
    return refused("STOP_OUT_ORDER_UNVERIFIED", request.initialBalance);
  }
  if (
    (c.accountMode !== "HEDGING" && c.accountMode !== "NETTING") ||
    (c.liquidationOrder !== "LARGEST_LOSS_FIRST" && c.liquidationOrder !== "FIFO") ||
    !isFinitePositive(c.leverage) ||
    !isFinitePositive(c.contractSize) ||
    !isFinitePositive(c.marginCallLevelPct) ||
    !isFinitePositive(c.stopOutLevelPct) ||
    c.stopOutLevelPct > c.marginCallLevelPct ||
    !isFiniteNonNegative(c.commissionPerLotRoundTrip) ||
    !isFiniteNonNegative(c.slippagePerLotRoundTrip)
  ) {
    return refused("BROKER_CONTRACT_INVALID", request.initialBalance);
  }

  const ticks = request.ticks;
  if (!Array.isArray(ticks) || ticks.length === 0) {
    return refused("TICK_PATH_UNVERIFIED", request.initialBalance);
  }
  let prevTs = -Infinity;
  for (const tick of ticks) {
    if (
      !tick ||
      tick.verifiedSource !== true ||
      !isFinitePositive(tick.timestampMs) ||
      !isFinitePositive(tick.bid) ||
      !isFinitePositive(tick.ask) ||
      tick.ask < tick.bid ||
      tick.timestampMs < prevTs
    ) {
      return refused("TICK_PATH_UNVERIFIED", request.initialBalance);
    }
    prevTs = tick.timestampMs;
  }

  for (const order of request.orders) {
    if (
      !order ||
      !order.id ||
      (order.side !== "BUY" && order.side !== "SELL") ||
      !isFinitePositive(order.volume) ||
      !isFinitePositive(order.submittedAtMs)
    ) {
      return refused("ORDER_INTENT_INVALID", request.initialBalance);
    }
  }

  const contract: BrokerMarginContract = {
    accountMode: c.accountMode,
    leverage: c.leverage,
    contractSize: c.contractSize,
    marginCallLevelPct: c.marginCallLevelPct,
    stopOutLevelPct: c.stopOutLevelPct,
    liquidationOrder: c.liquidationOrder,
    commissionPerLotRoundTrip: c.commissionPerLotRoundTrip,
    slippagePerLotRoundTrip: c.slippagePerLotRoundTrip,
    contractVerified: true,
    liquidationOrderVerified: true,
    costsVerified: c.costsVerified === true,
  };

  let balance = request.initialBalance;
  let totalRealizedPnl = 0;
  let totalCommissions = 0;
  let totalSlippage = 0;
  let marginCallTriggered = false;
  let stopOutTriggered = false;

  const openPositions: OpenReplayPosition[] = [];
  const processedOrderIds = new Set<string>();
  const rejectedOrderIds: string[] = [];
  const liquidatedOrderIds: string[] = [];
  const ledger: CollateralLedgerEntry[] = [];

  const totalUsedMargin = (): number =>
    openPositions.reduce((acc, p) => acc + p.usedMargin, 0);

  const accountSnapshot = (tick: BrokerTick): {
    equity: number;
    usedMargin: number;
    marginLevelPct: number | null;
  } => {
    const floating = openPositions.reduce(
      (acc, p) => acc + computePositionFloatingPnl(p, tick, contract.contractSize),
      0
    );
    const equity = balance + floating;
    const usedMargin = totalUsedMargin();
    const marginLevelPct = usedMargin > 0 ? (equity / usedMargin) * 100 : null;
    return { equity, usedMargin, marginLevelPct };
  };

  for (const tick of ticks) {
    for (const intent of request.orders) {
      if (processedOrderIds.has(intent.id) || intent.submittedAtMs > tick.timestampMs) {
        continue;
      }
      processedOrderIds.add(intent.id);

      const fillPrice = intent.side === "BUY" ? tick.ask : tick.bid;
      const halfComm = (contract.commissionPerLotRoundTrip * intent.volume) / 2;
      const halfSlip = (contract.slippagePerLotRoundTrip * intent.volume) / 2;
      const requiredMargin =
        (intent.volume * contract.contractSize * fillPrice) / contract.leverage;

      if (
        contract.accountMode === "NETTING" &&
        openPositions.some((p) => p.side !== intent.side)
      ) {
        rejectedOrderIds.push(intent.id);
        continue;
      }

      const snapBefore = accountSnapshot(tick);
      const projectedBalance = balance - halfComm - halfSlip;
      const projectedUsedMargin = snapBefore.usedMargin + requiredMargin;
      const projectedEquity = snapBefore.equity - halfComm - halfSlip;
      const freeMarginAfter = projectedEquity - projectedUsedMargin;
      const marginLevelAfter =
        projectedUsedMargin > 0 ? (projectedEquity / projectedUsedMargin) * 100 : Infinity;

      if (
        projectedBalance <= 0 ||
        freeMarginAfter < 0 ||
        marginLevelAfter <= contract.stopOutLevelPct
      ) {
        rejectedOrderIds.push(intent.id);
        continue;
      }

      balance = projectedBalance;
      totalCommissions += halfComm;
      totalSlippage += halfSlip;
      openPositions.push({
        id: intent.id,
        side: intent.side,
        volume: intent.volume,
        entryPrice: fillPrice,
        openedAtMs: tick.timestampMs,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        isDcaLayer: Boolean(intent.isDcaLayer),
        usedMargin: requiredMargin,
      });

      const snapAfter = accountSnapshot(tick);
      ledger.push({
        timestampMs: tick.timestampMs,
        eventType: "ENTRY_FILL",
        orderId: intent.id,
        side: intent.side,
        volume: intent.volume,
        executionPrice: fillPrice,
        grossPnl: 0,
        commissionFee: round2(halfComm),
        slippageFee: round2(halfSlip),
        balanceAfter: round2(balance),
        equityAfter: round2(snapAfter.equity),
        usedMarginAfter: round2(snapAfter.usedMargin),
        marginLevelPctAfter:
          snapAfter.marginLevelPct === null ? null : round2(snapAfter.marginLevelPct),
      });
    }

    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const closePrice = pos.side === "BUY" ? tick.bid : tick.ask;
      const hitSl =
        pos.stopLoss !== undefined &&
        (pos.side === "BUY" ? closePrice <= pos.stopLoss : closePrice >= pos.stopLoss);
      const hitTp =
        !hitSl &&
        pos.takeProfit !== undefined &&
        (pos.side === "BUY" ? closePrice >= pos.takeProfit : closePrice <= pos.takeProfit);

      if (!hitSl && !hitTp) {
        continue;
      }

      const grossPnl = computePositionFloatingPnl(pos, tick, contract.contractSize);
      const exitComm = (contract.commissionPerLotRoundTrip * pos.volume) / 2;
      const exitSlip = (contract.slippagePerLotRoundTrip * pos.volume) / 2;
      balance += grossPnl - exitComm - exitSlip;
      totalRealizedPnl += grossPnl;
      totalCommissions += exitComm;
      totalSlippage += exitSlip;
      openPositions.splice(i, 1);

      const snapAfter = accountSnapshot(tick);
      ledger.push({
        timestampMs: tick.timestampMs,
        eventType: hitSl ? "SL_EXIT" : "TP_EXIT",
        orderId: pos.id,
        side: pos.side,
        volume: pos.volume,
        executionPrice: closePrice,
        grossPnl: round2(grossPnl),
        commissionFee: round2(exitComm),
        slippageFee: round2(exitSlip),
        balanceAfter: round2(balance),
        equityAfter: round2(snapAfter.equity),
        usedMarginAfter: round2(snapAfter.usedMargin),
        marginLevelPctAfter:
          snapAfter.marginLevelPct === null ? null : round2(snapAfter.marginLevelPct),
      });
    }

    let snap = accountSnapshot(tick);
    if (
      !marginCallTriggered &&
      snap.usedMargin > 0 &&
      snap.marginLevelPct !== null &&
      snap.marginLevelPct <= contract.marginCallLevelPct
    ) {
      marginCallTriggered = true;
      ledger.push({
        timestampMs: tick.timestampMs,
        eventType: "MARGIN_CALL_BREACH",
        orderId: "ACCOUNT",
        grossPnl: 0,
        commissionFee: 0,
        slippageFee: 0,
        balanceAfter: round2(balance),
        equityAfter: round2(snap.equity),
        usedMarginAfter: round2(snap.usedMargin),
        marginLevelPctAfter: round2(snap.marginLevelPct),
      });
    }

    while (
      openPositions.length > 0 &&
      snap.usedMargin > 0 &&
      snap.marginLevelPct !== null &&
      snap.marginLevelPct <= contract.stopOutLevelPct
    ) {
      stopOutTriggered = true;
      let targetIdx = 0;
      if (contract.liquidationOrder === "LARGEST_LOSS_FIRST") {
        let worstPnl = Infinity;
        for (let i = 0; i < openPositions.length; i++) {
          const pnl = computePositionFloatingPnl(
            openPositions[i]!,
            tick,
            contract.contractSize
          );
          if (pnl < worstPnl) {
            worstPnl = pnl;
            targetIdx = i;
          }
        }
      }

      const victim = openPositions[targetIdx]!;
      const closePrice = victim.side === "BUY" ? tick.bid : tick.ask;
      const grossPnl = computePositionFloatingPnl(victim, tick, contract.contractSize);
      const exitComm = (contract.commissionPerLotRoundTrip * victim.volume) / 2;
      const exitSlip = (contract.slippagePerLotRoundTrip * victim.volume) / 2;

      balance += grossPnl - exitComm - exitSlip;
      totalRealizedPnl += grossPnl;
      totalCommissions += exitComm;
      totalSlippage += exitSlip;
      openPositions.splice(targetIdx, 1);
      liquidatedOrderIds.push(victim.id);

      snap = accountSnapshot(tick);
      ledger.push({
        timestampMs: tick.timestampMs,
        eventType: "STOP_OUT_LIQUIDATION",
        orderId: victim.id,
        side: victim.side,
        volume: victim.volume,
        executionPrice: closePrice,
        grossPnl: round2(grossPnl),
        commissionFee: round2(exitComm),
        slippageFee: round2(exitSlip),
        balanceAfter: round2(balance),
        equityAfter: round2(snap.equity),
        usedMarginAfter: round2(snap.usedMargin),
        marginLevelPctAfter:
          snap.marginLevelPct === null ? null : round2(snap.marginLevelPct),
      });
    }
  }

  const lastTick = ticks[ticks.length - 1]!;
  const finalSnap = accountSnapshot(lastTick);
  return {
    ok: true,
    fidelity: {
      scope: "TICK_ORDERED_BROKER_CONTRACT_REPLAY",
      brokerStopOutExecutionVerified: true,
      stopOutLiquidationSimulated: true,
      intrabarMarginStressSimulated: true,
      tickOrderedBidAskVerified: true,
      brokerTradingCostsVerified: contract.costsVerified,
    },
    finalBalance: round2(balance),
    finalEquity: round2(finalSnap.equity),
    totalRealizedPnl: round2(totalRealizedPnl),
    totalCommissions: round2(totalCommissions),
    totalSlippage: round2(totalSlippage),
    marginCallTriggered,
    stopOutTriggered,
    liquidatedOrderIds,
    rejectedOrderIds,
    remainingOpenPositions: openPositions,
    ledger,
  };
}
