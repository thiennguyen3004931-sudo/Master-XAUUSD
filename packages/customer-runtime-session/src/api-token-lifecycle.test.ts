import { describe, expect, it } from "vitest";
import {
  LedgerCustomerApiKeyAuthenticator,
  type CustomerApiTokenLifecycleRecord,
} from "./api-token-lifecycle.js";
import { sha256CustomerApiToken } from "./api-gateway.js";

const TOKEN_A = "test-token-a-with-random-like-bytes-001";
const TOKEN_B = "test-token-b-with-random-like-bytes-002";
const NOW = 2_000_000;
const tokenRecord = (token: string, patch: Partial<CustomerApiTokenLifecycleRecord> = {}): CustomerApiTokenLifecycleRecord => ({
  customerId: "customer-001",
  tokenSha256Hex: sha256CustomerApiToken(token),
  status: "ACTIVE",
  notBeforeMs: NOW - 500,
  expiresAtMs: NOW + 5_000,
  revokedAtMs: null,
  generation: 1,
  ...patch,
});

function fixture() {
  const records = new Map<string, CustomerApiTokenLifecycleRecord>();
  let now = NOW;
  let unavailable = false;
  const ledger = {
    async getBySha256(digest: string) {
      if (unavailable) throw new Error("private database detail");
      return records.get(digest) ?? null;
    },
  };
  const clock = { now: () => now };
  return {
    records,
    auth: new LedgerCustomerApiKeyAuthenticator(ledger, clock),
    setNow: (value: number) => { now = value; },
    setUnavailable: () => { unavailable = true; },
  };
}

describe("LedgerCustomerApiKeyAuthenticator", () => {
  it("authenticates active token and denies unknown or malformed credentials", async () => {
    const f = fixture(); f.records.set(sha256CustomerApiToken(TOKEN_A), tokenRecord(TOKEN_A));
    await expect(f.auth.authenticate(TOKEN_A)).resolves.toEqual({ customerId: "customer-001" });
    await expect(f.auth.authenticate(TOKEN_B)).resolves.toBeNull();
    await expect(f.auth.authenticate(" ")).resolves.toBeNull();
  });
  it("rejects before not-before and exactly at expiry", async () => {
    const f = fixture(); f.records.set(sha256CustomerApiToken(TOKEN_A), tokenRecord(TOKEN_A));
    f.setNow(NOW - 501); await expect(f.auth.authenticate(TOKEN_A)).resolves.toBeNull();
    f.setNow(NOW + 5000); await expect(f.auth.authenticate(TOKEN_A)).resolves.toBeNull();
  });
  it("revocation takes effect on the very next authentication", async () => {
    const f = fixture(); const digest = sha256CustomerApiToken(TOKEN_A);
    f.records.set(digest, tokenRecord(TOKEN_A));
    await expect(f.auth.authenticate(TOKEN_A)).resolves.not.toBeNull();
    f.records.set(digest, tokenRecord(TOKEN_A, { status: "REVOKED", revokedAtMs: NOW, generation: 2 }));
    await expect(f.auth.authenticate(TOKEN_A)).resolves.toBeNull();
  });
  it("bounded overlap and revocation of old token during rotation", async () => {
    const f = fixture(), a = sha256CustomerApiToken(TOKEN_A), b = sha256CustomerApiToken(TOKEN_B);
    f.records.set(a, tokenRecord(TOKEN_A, { expiresAtMs: NOW + 1000 }));
    f.records.set(b, tokenRecord(TOKEN_B, { generation: 2 }));
    await expect(f.auth.authenticate(TOKEN_A)).resolves.not.toBeNull();
    await expect(f.auth.authenticate(TOKEN_B)).resolves.not.toBeNull();
    f.setNow(NOW + 1000);
    await expect(f.auth.authenticate(TOKEN_A)).resolves.toBeNull();
    await expect(f.auth.authenticate(TOKEN_B)).resolves.not.toBeNull();
    f.records.set(b, tokenRecord(TOKEN_B, { status: "REVOKED", revokedAtMs: NOW + 1001, generation: 3 }));
    await expect(f.auth.authenticate(TOKEN_B)).resolves.toBeNull();
  });
  it("rejects invalid ledger record rather than accepting incomplete revocation", async () => {
    const f = fixture();
    f.records.set(sha256CustomerApiToken(TOKEN_A), tokenRecord(TOKEN_A, { status: "REVOKED", revokedAtMs: null }));
    await expect(f.auth.authenticate(TOKEN_A)).rejects.toThrow("TOKEN_LEDGER_INVALID");
  });
  it("rejects mismatched digest from a corrupted ledger", async () => {
    const f = fixture();
    f.records.set(sha256CustomerApiToken(TOKEN_A), tokenRecord(TOKEN_B));
    await expect(f.auth.authenticate(TOKEN_A)).rejects.toThrow("TOKEN_LEDGER_BINDING_INVALID");
  });
  it("fails closed during ledger outage with sanitized error", async () => {
    const f = fixture(); f.setUnavailable();
    await expect(f.auth.authenticate(TOKEN_A)).rejects.toThrow("TOKEN_LEDGER_UNAVAILABLE");
  });
  it("fails closed for invalid clock", async () => {
    const f = fixture(); f.setNow(Number.NaN);
    await expect(f.auth.authenticate(TOKEN_A)).rejects.toThrow("TOKEN_CLOCK_UNAVAILABLE");
  });
  it("new process authenticator sees the same ledger revocation state", async () => {
    const f = fixture(), digest = sha256CustomerApiToken(TOKEN_A);
    f.records.set(digest, tokenRecord(TOKEN_A, { status: "REVOKED", revokedAtMs: NOW, generation: 2 }));
    const recreated = new LedgerCustomerApiKeyAuthenticator({
      getBySha256: async (hash) => f.records.get(hash) ?? null,
    }, { now: () => NOW });
    await expect(recreated.authenticate(TOKEN_A)).resolves.toBeNull();
  });
});
