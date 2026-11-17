import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMt5Transport, defaultMt5BrokerConfig } from "../src";

afterEach(() => vi.restoreAllMocks());

describe("HttpMt5Transport", () => {
  it("sends the bridge API key", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ connected: true }), { status: 200 }),
    );
    const transport = new HttpMt5Transport({
      ...defaultMt5BrokerConfig,
      apiKey: "secret",
      retryAttempts: 0,
    });
    await transport.request({ method: "GET", path: "health" });
    expect(spy).toHaveBeenCalledOnce();
    const init = spy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["X-MT5-API-Key"]).toBe("secret");
  });

  it("maps an unauthorized response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "invalid key" }), { status: 401 }),
    );
    const transport = new HttpMt5Transport({
      ...defaultMt5BrokerConfig,
      apiKey: "bad",
      retryAttempts: 0,
    });
    await expect(transport.request({ method: "GET", path: "health" })).rejects.toMatchObject({
      code: "AUTHENTICATION_ERROR",
    });
  });
});
