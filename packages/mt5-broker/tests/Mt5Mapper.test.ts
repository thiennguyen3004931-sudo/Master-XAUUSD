import { describe, expect, it } from "vitest";
import { PositionSide } from "@xauusd/types";
import { Mt5Mapper, defaultMt5BrokerConfig } from "../src";
import { createOrder, createOrderResponse } from "./fixtures";

describe("Mt5Mapper", () => {
  it("maps normalized orders to bridge requests", () => {
    const request = new Mt5Mapper().toOrderRequest(createOrder(), {
      ...defaultMt5BrokerConfig,
      apiKey: "key",
    });
    expect(request.side).toBe("BUY");
    expect(request.magicNumber).toBe(defaultMt5BrokerConfig.magicNumber);
  });

  it("maps bridge positions to common positions", () => {
    const position = new Mt5Mapper().toPosition(createOrderResponse().position!);
    expect(position.side).toBe(PositionSide.LONG);
  });
});
