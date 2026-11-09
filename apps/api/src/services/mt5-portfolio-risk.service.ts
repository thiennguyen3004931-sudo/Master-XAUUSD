import type {
  Mt5BridgePosition,
  Mt5BridgeSymbolSpec,
} from "@xauusd/mt5-broker";
import {
  PositionSide,
  type Position,
} from "@xauusd/types";

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`Invalid MT5 portfolio risk field: ${field}.`);
  }
}

function failClosedRisk(accountEquity: number): number {
  assertFinitePositive(accountEquity, "accountEquity");
  return accountEquity;
}

function canonicalPosition(source: Mt5BridgePosition): Position {
  return {
    ticket: source.ticket,
    symbol: source.symbol,
    side:
      source.side === "LONG"
        ? PositionSide.LONG
        : PositionSide.SHORT,
    volume: source.volume,
    entry: source.entry,
    stopLoss: source.stopLoss,
    takeProfit: source.takeProfit,
    profit: source.profit,
    swap: source.swap,
    commission: source.commission,
    ...(source.openedAt !== undefined
      ? { openedAt: source.openedAt }
      : {}),
  };
}

function calculateCurrentRiskAmount(
  source: Mt5BridgePosition,
  spec: Mt5BridgeSymbolSpec,
  bid: number,
  ask: number,
  accountEquity: number,
): number {
  assertFinitePositive(source.volume, "position.volume");
  assertFinitePositive(spec.tickSize, "spec.tickSize");
  assertFinitePositive(
    spec.effectiveTickValuePerLot,
    "spec.effectiveTickValuePerLot",
  );
  assertFinitePositive(bid, "quote.bid");
  assertFinitePositive(ask, "quote.ask");

  if (source.symbol !== spec.symbol) {
    return failClosedRisk(accountEquity);
  }

  if (!Number.isFinite(source.stopLoss) || source.stopLoss <= 0) {
    return failClosedRisk(accountEquity);
  }

  const closePrice = source.side === "LONG" ? bid : ask;
  const stopDistance =
    source.side === "LONG"
      ? closePrice - source.stopLoss
      : source.stopLoss - closePrice;

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    return failClosedRisk(accountEquity);
  }

  const stopTicks = stopDistance / spec.tickSize;
  const cashRisk =
    stopTicks *
    spec.effectiveTickValuePerLot *
    source.volume;

  if (!Number.isFinite(cashRisk) || cashRisk < 0) {
    return failClosedRisk(accountEquity);
  }

  return cashRisk;
}

export function buildMt5OpenRiskPositions(
  positions: readonly Mt5BridgePosition[],
  spec: Mt5BridgeSymbolSpec,
  bid: number,
  ask: number,
  accountEquity: number,
) {
  assertFinitePositive(accountEquity, "accountEquity");

  return positions.map((source) => {
    const position = canonicalPosition(source);
    const currentRiskAmount = calculateCurrentRiskAmount(
      source,
      spec,
      bid,
      ask,
      accountEquity,
    );

    return {
      position,
      initialRiskAmount: currentRiskAmount,
      currentRiskAmount,
    };
  });
}
