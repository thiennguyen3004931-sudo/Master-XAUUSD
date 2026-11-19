import {
  OrderSide,
  PositionSide,
  type Position,
} from "@xauusd/types";
import type {
  BrokerOrderReceipt,
  ExecutionQuote,
  ManagementCommandResult,
  NormalizedExecutionOrder,
  SymbolExecutionSpec,
} from "@xauusd/execution-engine";
import type { Mt5BrokerConfig } from "../config";
import type {
  Mt5BridgeCommandResponse,
  Mt5BridgeOrderRequest,
  Mt5BridgeOrderResponse,
  Mt5BridgePosition,
  Mt5BridgeQuote,
  Mt5BridgeSymbolSpec,
} from "../models";

export class Mt5Mapper {
  toOrderRequest(order: NormalizedExecutionOrder, config: Mt5BrokerConfig): Mt5BridgeOrderRequest {
    return {
      symbol: order.symbol,
      side: order.side === OrderSide.BUY ? "BUY" : "SELL",
      orderType: order.orderType,
      timeInForce: order.timeInForce,
      volume: order.volume,
      requestedPrice: order.requestedPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      deviationPoints: config.deviationPoints,
      magicNumber: config.magicNumber,
      comment: order.original.comment ?? "xauusd-ai-master",
      clientOrderId: order.clientOrderId,
      idempotencyKey: order.idempotencyKey,
      expiresAt: order.expiresAt,
    };
  }

  toReceipt(response: Mt5BridgeOrderResponse): BrokerOrderReceipt {
    return {
      accepted: response.accepted,
      status: response.status,
      brokerOrderId: response.brokerOrderId,
      ticket: response.ticket,
      position: response.position ? this.toPosition(response.position) : undefined,
      fillPrice: response.fillPrice,
      filledVolume: response.filledVolume,
      message: response.message,
      brokerTimestamp: response.brokerTimestamp,
    };
  }

  toQuote(response: Mt5BridgeQuote): ExecutionQuote {
    return {
      symbol: response.symbol,
      bid: response.bid,
      ask: response.ask,
      spread: response.spread,
      timestamp: response.timestamp,
    };
  }

  toSpec(response: Mt5BridgeSymbolSpec): SymbolExecutionSpec {
    return {
      symbol: response.symbol,
      tickSize: response.tickSize,
      digits: response.digits,
      minVolume: response.minVolume,
      maxVolume: response.maxVolume,
      volumeStep: response.volumeStep,
      maxSpread: response.maxSpread,
      stopsLevelTicks: response.stopsLevelTicks,
      freezeLevelTicks: response.freezeLevelTicks,
    };
  }

  toPosition(response: Mt5BridgePosition): Position {
    return {
      ticket: response.ticket,
      symbol: response.symbol,
      side: response.side === "LONG" ? PositionSide.LONG : PositionSide.SHORT,
      volume: response.volume,
      entry: response.entry,
      stopLoss: response.stopLoss,
      takeProfit: response.takeProfit,
      profit: response.profit,
      swap: response.swap,
      commission: response.commission,
      openedAt: response.openedAt,
    };
  }

  toCommandResult(response: Mt5BridgeCommandResponse): ManagementCommandResult {
    return {
      commandId: response.commandId,
      success: response.success,
      message: response.message,
      executedAt: response.executedAt,
    };
  }
}
