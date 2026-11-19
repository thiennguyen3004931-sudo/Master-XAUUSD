import { describe, expect, it } from "vitest";
import { SessionService, TradingSession } from "../src";

describe("SessionService", () => {
  const service = new SessionService();

  it("detects London and New York overlap", () => {
    expect(service.getSession(new Date("2026-08-06T13:00:00Z"))).toBe(
      TradingSession.OVERLAP,
    );
  });

  it("detects the Asian session", () => {
    expect(service.getSession(new Date("2026-08-06T03:00:00Z"))).toBe(
      TradingSession.ASIAN,
    );
  });
});
