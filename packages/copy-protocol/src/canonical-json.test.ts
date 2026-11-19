import { describe, expect, it } from "vitest";
import type { CopyCommandBody, JsonValue } from "./command.js";
import {
  canonicalizeCopyCommandBody,
  canonicalizeJson,
  copyCommandSigningBytes
} from "./canonical-json.js";

const validBody: CopyCommandBody = {
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
};

const expectedCanonical =
  '{"action":"POSITION_OPEN","brokerServer":"Broker-Live","commandId":"cmd-0001","expiresAt":1789000030000,"installationId":"inst-0001","issuedAt":1789000000000,"keyId":"master-ed25519-2026-01","licenseId":"lic-0001","masterPositionRef":"master-pos-1","mt5Login":12345678,"payload":{"side":"BUY","volume":0.03},"sequence":1,"symbol":"XAUUSD","version":1}';

describe("canonical JSON", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalizeJson({ z: 1, a: { y: 2, x: 1 } })).toBe(
      '{"a":{"x":1,"y":2},"z":1}'
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalizeJson({ a: 1, b: 2 })).toBe(
      canonicalizeJson({ b: 2, a: 1 })
    );
  });

  it("preserves array element order", () => {
    expect(canonicalizeJson({ values: [3, 1, 2] })).toBe(
      '{"values":[3,1,2]}'
    );
  });

  it("locks the exact command signing string", () => {
    expect(canonicalizeCopyCommandBody(validBody)).toBe(expectedCanonical);
    expect(expectedCanonical).toContain('"keyId":"master-ed25519-2026-01"');
    expect(expectedCanonical).not.toContain("signature");
  });

  it("produces exact UTF-8 signing bytes", () => {
    expect(new TextDecoder().decode(copyCommandSigningBytes(validBody))).toBe(
      expectedCanonical
    );
  });

  it("rejects non-finite runtime numbers", () => {
    expect(() => canonicalizeJson(Number.NaN as unknown as JsonValue)).toThrow(
      "finite"
    );
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY as unknown as JsonValue)).toThrow(
      "finite"
    );
  });

  it("rejects sparse runtime arrays", () => {
    const sparse = new Array(2) as unknown[];
    sparse[1] = 1;
    expect(() => canonicalizeJson(sparse as unknown as JsonValue)).toThrow(
      "sparse"
    );
  });

  it("rejects non-plain runtime objects", () => {
    expect(() => canonicalizeJson(new Date(0) as unknown as JsonValue)).toThrow(
      "plain"
    );
  });

  it("rejects cyclic runtime objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic as unknown as JsonValue)).toThrow(
      "cyclic"
    );
  });
});
