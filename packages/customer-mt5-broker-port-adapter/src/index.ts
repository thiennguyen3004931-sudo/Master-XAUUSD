import type { CustomerMt5BridgePort } from "@xauusd/customer-agent";
import type { IMt5BridgeClient } from "@xauusd/mt5-broker";

export class CustomerMt5BrokerPortAdapter implements CustomerMt5BridgePort {
  constructor(private readonly client: IMt5BridgeClient) {}

  async health() {
    const health = await this.client.health();
    return {
      connected: health.connected,
      tradingEnabled: health.tradingEnabled,
      terminalTradeAllowed: health.terminalTradeAllowed,
      expertTradeAllowed: health.expertTradeAllowed,
      accountLogin: health.accountLogin,
      server: health.server,
    };
  }

  async quote(symbol: string) {
    const quote = await this.client.quote(symbol);
    return { bid: quote.bid, ask: quote.ask };
  }

  async placeOrder(request: Parameters<CustomerMt5BridgePort["placeOrder"]>[0]) {
    return this.client.placeOrder(request);
  }

  async modifyPosition(
    ticket: string,
    stopLoss: number,
    takeProfit: number | undefined,
    commandId: string,
  ) {
    return this.client.modifyPosition(
      ticket,
      stopLoss,
      takeProfit,
      commandId,
    );
  }

  async closePosition(ticket: string, volume: number, commandId: string) {
    return this.client.closePosition(ticket, volume, commandId);
  }

  async openPositions(symbol?: string) {
    const positions = await this.client.openPositions(symbol);
    return positions.map((position) => ({
      ticket: position.ticket,
      symbol: position.symbol,
      volume: position.volume,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      side: position.side,
    }));
  }
}
