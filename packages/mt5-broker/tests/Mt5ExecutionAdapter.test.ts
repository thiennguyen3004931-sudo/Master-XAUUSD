import { describe, expect, it } from "vitest";
import { PositionSide } from "@xauusd/types";
import type { IMt5BridgeClient } from "../src";
import { Mt5ExecutionAdapter } from "../src";
import { createHealth, createOrder, createOrderResponse, createQuote, createSpec } from "./fixtures";

function client(): IMt5BridgeClient {
  return {
    health: async () => createHealth(),
    quote: async () => createQuote(),
    symbolSpec: async () => createSpec(),
    placeOrder: async () => createOrderResponse(),
    cancelOrder: async () => ({ success: true, message: "cancelled", executedAt: Date.now(), idempotentReplay: false }),
    closePosition: async (_ticket, _volume, commandId) => ({ commandId, success: true, message: "closed", executedAt: Date.now(), idempotentReplay: false }),
    modifyPosition: async (_ticket, _sl, _tp, commandId) => ({ commandId, success: true, message: "modified", executedAt: Date.now(), idempotentReplay: false }),
    openPositions: async () => [createOrderResponse().position!],
  };
}

describe("Mt5ExecutionAdapter", () => {
  it("implements the Pack 08 adapter contract", async () => {
    const adapter = new Mt5ExecutionAdapter(client(), { apiKey: "test-key" });
    expect(await adapter.isConnected()).toBe(true);
    expect((await adapter.getQuote("XAUUSD")).ask).toBe(2400);
    expect((await adapter.getSymbolSpec("XAUUSD")).volumeStep).toBe(0.01);
    expect((await adapter.placeOrder(createOrder())).accepted).toBe(true);
    expect((await adapter.getOpenPositions())[0]?.side).toBe(PositionSide.LONG);
  });

  it("fails closed when trading is disabled", async () => {
    const disabled = client();
    disabled.health = async () => createHealth({ tradingEnabled: false });
    const adapter = new Mt5ExecutionAdapter(disabled, { apiKey: "test-key" });
    await expect(adapter.placeOrder(createOrder())).rejects.toThrow("disabled");
  });
});
