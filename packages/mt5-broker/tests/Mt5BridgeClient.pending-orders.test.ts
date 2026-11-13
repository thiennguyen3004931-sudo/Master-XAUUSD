import { describe, expect, it } from "vitest";
import {
  Mt5BridgeClient,
  type IMt5Transport,
  type Mt5TransportRequest,
} from "../src";

class RecordingTransport implements IMt5Transport {
  readonly requests: Mt5TransportRequest[] = [];

  async request<T>(request: Mt5TransportRequest): Promise<T> {
    this.requests.push(request);
    return [] as T;
  }
}

describe("Mt5BridgeClient pending orders", () => {
  it("uses the read-only broker pending-order endpoint with a canonical symbol", async () => {
    const transport = new RecordingTransport();
    const client = new Mt5BridgeClient(transport);

    await expect(client.pendingOrders("XAUUSD")).resolves.toEqual([]);
    expect(transport.requests).toEqual([
      { method: "GET", path: "v1/orders?symbol=XAUUSD" },
    ]);
  });

  it("uses the all-pending-orders endpoint when symbol is omitted", async () => {
    const transport = new RecordingTransport();
    const client = new Mt5BridgeClient(transport);

    await expect(client.pendingOrders()).resolves.toEqual([]);
    expect(transport.requests).toEqual([
      { method: "GET", path: "v1/orders" },
    ]);
  });
});
