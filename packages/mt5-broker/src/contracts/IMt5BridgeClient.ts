import type {
  Mt5BridgeCancelResponse,
  Mt5BridgeCommandResponse,
  Mt5BridgeHealth,
  Mt5BridgeOrderRequest,
  Mt5BridgeOrderResponse,
  Mt5BridgePendingOrder,
  Mt5BridgePosition,
  Mt5BridgeQuote,
  Mt5BridgeSymbolSpec,
} from "../models";

export interface IMt5BridgeClient {
  health(): Promise<Mt5BridgeHealth>;
  quote(symbol: string): Promise<Mt5BridgeQuote>;
  symbolSpec(symbol: string): Promise<Mt5BridgeSymbolSpec>;
  placeOrder(request: Mt5BridgeOrderRequest): Promise<Mt5BridgeOrderResponse>;
  cancelOrder(ticket: string): Promise<Mt5BridgeCancelResponse>;
  closePosition(ticket: string, volume: number, commandId: string): Promise<Mt5BridgeCommandResponse>;
  modifyPosition(ticket: string, stopLoss: number, takeProfit: number | undefined, commandId: string): Promise<Mt5BridgeCommandResponse>;
  openPositions(symbol?: string): Promise<Mt5BridgePosition[]>;
  pendingOrders(symbol?: string): Promise<Mt5BridgePendingOrder[]>;
}
