import { OrderSide } from "@xauusd/types";
import type { NormalizedExecutionOrder } from "@xauusd/execution-engine";
import type {
  Mt5BridgeHealth,
  Mt5BridgeOrderResponse,
  Mt5BridgeQuote,
  Mt5BridgeSymbolSpec,
} from "../src";

export const NOW = 1_700_000_000_000;

export function createHealth(overrides: Partial<Mt5BridgeHealth> = {}): Mt5BridgeHealth {
  return {
    status: "ok",
    connected: true,
    tradingEnabled: true,
    terminalTradeAllowed: true,
    expertTradeAllowed: true,
    accountLogin: 123456,
    accountMode: "demo",
    server: "Broker-Demo",
    terminalVersion: "5.0",
    timestamp: NOW,
    ...overrides,
  };
}

export function createQuote(overrides: Partial<Mt5BridgeQuote> = {}): Mt5BridgeQuote {
  return {
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSDm",
    bid: 2399.9,
    ask: 2400,
    spread: 0.1,
    timestamp: NOW,
    ...overrides,
  };
}

export function createSpec(overrides: Partial<Mt5BridgeSymbolSpec> = {}): Mt5BridgeSymbolSpec {
  return {
    symbol: "XAUUSD",
    brokerSymbol: "XAUUSDm",
    tickSize: 0.01,
    digits: 2,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    maxSpread: 0.5,
    stopsLevelTicks: 10,
    freezeLevelTicks: 5,
    fillingMode: 3,
    executionMode: 2,
    ...overrides,
  };
}

export function createOrder(): NormalizedExecutionOrder {
  return {
    original: {
      symbol: "XAUUSD",
      side: OrderSide.BUY,
      volume: 0.2,
      entry: 2400,
      stopLoss: 2395,
      takeProfit: 2411,
      comment: "test",
      clientOrderId: "client-1",
    },
    symbol: "XAUUSD",
    side: OrderSide.BUY,
    orderType: "MARKET",
    timeInForce: "IOC",
    volume: 0.2,
    requestedPrice: 2400,
    stopLoss: 2395,
    takeProfit: 2411,
    clientOrderId: "client-1",
    idempotencyKey: "idempotency-1",
  };
}

export function createOrderResponse(overrides: Partial<Mt5BridgeOrderResponse> = {}): Mt5BridgeOrderResponse {
  return {
    accepted: true,
    status: "FILLED",
    brokerOrderId: "1001",
    ticket: "2001",
    fillPrice: 2400,
    filledVolume: 0.2,
    message: "filled",
    brokerTimestamp: NOW,
    idempotentReplay: false,
    position: {
      ticket: "2001",
      symbol: "XAUUSD",
      brokerSymbol: "XAUUSDm",
      side: "LONG",
      volume: 0.2,
      entry: 2400,
      stopLoss: 2395,
      takeProfit: 2411,
      profit: 0,
      swap: 0,
      commission: 0,
      openedAt: NOW,
    },
    ...overrides,
  };
}
