import { describe, expect, it, vi } from "vitest";
import {
  executeMobileArm,
  executeMobileMode,
  getMobileArmStatus,
  getMobileM4State,
  preflightMobileArm,
} from "../apps/web/src/mobile-m4-control";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mobile M4 same-origin client", () => {
  it("reads bounded state from same-origin M4 endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ mode: "PAUSE" }));
    await getMobileM4State(fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith("/__m4/state", expect.objectContaining({ method: "GET" }));
  });

  it("sends fixed mode action and confirmation only", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ outcome: "PASS" }));
    await executeMobileMode("TREND", fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/__m4/action");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      action: "MODE_TREND",
      confirmation: "MODE_TREND",
    });
  });

  it("uses bounded ARM preflight/execute/status contracts", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ approved: true, transactionId: "gateway-transaction" }));
    await preflightMobileArm("ARM_LIVE", fetchImpl as typeof fetch);
    await executeMobileArm("ARM_LIVE", "gateway-transaction", fetchImpl as typeof fetch);
    await getMobileArmStatus("gateway-transaction", fetchImpl as typeof fetch);

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      action: "ARM_LIVE",
      phase: "PREFLIGHT",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      action: "ARM_LIVE",
      phase: "EXECUTE",
      transactionId: "gateway-transaction",
      confirmation: "ARM_LIVE",
    });
    expect(fetchImpl.mock.calls[2][0]).toBe("/__m4/status?transactionId=gateway-transaction");
  });

  it("never uses localhost API URL", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return jsonResponse({ mode: "PAUSE", outcome: "PASS", transactionId: "tx" });
    });
    await getMobileM4State(fetchImpl as typeof fetch);
    await executeMobileMode("PAUSE", fetchImpl as typeof fetch);
    await preflightMobileArm("DISARM_LIVE", fetchImpl as typeof fetch);
    expect(seen.every((url) => url.startsWith("/__m4/"))).toBe(true);
    expect(seen.some((url) => url.includes("127.0.0.1:3711"))).toBe(false);
  });
});
