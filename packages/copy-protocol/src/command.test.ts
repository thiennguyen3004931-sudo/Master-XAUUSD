import { describe, expect, it } from "vitest";
import { COPY_COMMAND_ACTIONS, assertCopyCommandBody } from "./command.js";

const validBody = {
  version: 1,
  commandId: "cmd-0001",
  sequence: 1,
  licenseId: "lic-0001",
  installationId: "inst-0001",
  mt5Login: 12345678,
  brokerServer: "Broker-Live",
  symbol: "XAUUSD",
  action: "POSITION_OPEN",
  payload: { side: "BUY", volume: 0.03 },
  masterPositionRef: "master-pos-1",
  issuedAt: 1_789_000_000_000,
  expiresAt: 1_789_000_030_000,
  keyId: "master-ed25519-2026-01"
} as const;

describe("copy command contract", () => {
  it("locks the exact V1 action allowlist", () => {
    expect(COPY_COMMAND_ACTIONS).toEqual([
      "POSITION_OPEN",
      "STOP_LOSS_UPDATE",
      "TAKE_PROFIT_UPDATE",
      "PARTIAL_CLOSE",
      "POSITION_CLOSE",
      "POSITION_SNAPSHOT"
    ]);
  });

  it("accepts a valid command body", () => {
    expect(() => assertCopyCommandBody(validBody)).not.toThrow();
  });

  it.each([
    [{ ...validBody, sequence: 0 }, "sequence"],
    [{ ...validBody, expiresAt: validBody.issuedAt }, "expiresAt"],
    [{ ...validBody, action: "RUN_STRATEGY" }, "action"],
    [{ ...validBody, payload: { bad: Number.NaN } }, "payload"]
  ])("rejects invalid security body %#", (body, field) => {
    expect(() => assertCopyCommandBody(body)).toThrow(field);
  });
});
