import type { IMt5BridgeClient, IMt5Transport } from "../contracts";
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

export class Mt5BridgeClient implements IMt5BridgeClient {
  constructor(private readonly transport: IMt5Transport, private readonly healthTimeoutMs = 2_000) {}

  health(): Promise<Mt5BridgeHealth> {
    return this.transport.request({ method: "GET", path: "health", timeoutMs: this.healthTimeoutMs });
  }

  quote(symbol: string): Promise<Mt5BridgeQuote> {
    return this.transport.request({ method: "GET", path: `v1/quotes/${encodeURIComponent(symbol)}` });
  }

  symbolSpec(symbol: string): Promise<Mt5BridgeSymbolSpec> {
    return this.transport.request({ method: "GET", path: `v1/symbols/${encodeURIComponent(symbol)}/spec` });
  }

  placeOrder(request: Mt5BridgeOrderRequest): Promise<Mt5BridgeOrderResponse> {
    return this.transport.request({ method: "POST", path: "v1/orders", body: request, idempotent: true });
  }

  cancelOrder(ticket: string): Promise<Mt5BridgeCancelResponse> {
    return this.transport.request({ method: "DELETE", path: `v1/orders/${encodeURIComponent(ticket)}`, idempotent: true });
  }

  closePosition(ticket: string, volume: number, commandId: string): Promise<Mt5BridgeCommandResponse> {
    return this.transport.request({
      method: "POST",
      path: `v1/positions/${encodeURIComponent(ticket)}/close`,
      body: { volume, commandId },
      idempotent: false,
    });
  }

  modifyPosition(ticket: string, stopLoss: number, takeProfit: number | undefined, commandId: string): Promise<Mt5BridgeCommandResponse> {
    return this.transport.request({
      method: "PATCH",
      path: `v1/positions/${encodeURIComponent(ticket)}`,
      body: { stopLoss, takeProfit, commandId },
      idempotent: false,
    });
  }

  openPositions(symbol?: string): Promise<Mt5BridgePosition[]> {
    const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return this.transport.request({ method: "GET", path: `v1/positions${query}` });
  }

  pendingOrders(symbol?: string): Promise<Mt5BridgePendingOrder[]> {
    const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    return this.transport.request({ method: "GET", path: `v1/orders${query}` });
  }
}
