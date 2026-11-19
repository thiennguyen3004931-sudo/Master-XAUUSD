import { timingSafeEqual } from "node:crypto";
import {
  sha256CustomerApiToken,
  type CustomerApiAuthenticator,
  type CustomerApiPrincipal,
} from "./api-gateway.js";

export interface CustomerApiTokenLifecycleRecord {
  readonly customerId: string;
  readonly tokenSha256Hex: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly generation: number;
}

/**
 * The implementation MUST read the latest token record from an independently
 * administered, durable ledger on every authentication. A restored customer
 * SQLite snapshot or a cached token list is NOT an acceptable source.
 */
export interface CustomerApiTokenLifecycleLedger {
  getBySha256(sha256Hex: string): Promise<CustomerApiTokenLifecycleRecord | null>;
}

export interface CustomerApiTokenClock {
  now(): number;
}

const canonical = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const validMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validRecord(record: CustomerApiTokenLifecycleRecord): boolean {
  return canonical(record.customerId) &&
    /^[0-9a-f]{64}$/.test(record.tokenSha256Hex) &&
    (record.status === "ACTIVE" || record.status === "REVOKED") &&
    validMs(record.notBeforeMs) &&
    validMs(record.expiresAtMs) &&
    record.expiresAtMs > record.notBeforeMs &&
    validMs(record.generation) &&
    record.generation > 0 &&
    (record.revokedAtMs === null || validMs(record.revokedAtMs)) &&
    !(record.status === "ACTIVE" && record.revokedAtMs !== null) &&
    !(record.status === "REVOKED" && record.revokedAtMs === null);
}

/** Drop-in Gateway authenticator; fail-closed on outage, revocation or expiry. */
export class LedgerCustomerApiKeyAuthenticator implements CustomerApiAuthenticator {
  constructor(
    private readonly ledger: CustomerApiTokenLifecycleLedger,
    private readonly clock: CustomerApiTokenClock,
  ) {
    if (!ledger || typeof ledger.getBySha256 !== "function" ||
        !clock || typeof clock.now !== "function") {
      throw new TypeError("independent token ledger and clock are required");
    }
  }

  async authenticate(bearerToken: string): Promise<CustomerApiPrincipal | null> {
    let digest: string;
    try {
      digest = sha256CustomerApiToken(bearerToken);
    } catch {
      return null;
    }

    let now: number;
    try {
      now = this.clock.now();
    } catch {
      throw new Error("TOKEN_CLOCK_UNAVAILABLE");
    }
    if (!validMs(now)) throw new Error("TOKEN_CLOCK_UNAVAILABLE");

    let record: CustomerApiTokenLifecycleRecord | null;
    try {
      record = await this.ledger.getBySha256(digest);
    } catch {
      throw new Error("TOKEN_LEDGER_UNAVAILABLE");
    }
    if (record === null) return null;
    if (!record || typeof record !== "object" || !validRecord(record)) {
      throw new Error("TOKEN_LEDGER_INVALID");
    }
    const candidate = Buffer.from(digest, "hex");
    const stored = Buffer.from(record.tokenSha256Hex, "hex");
    if (!timingSafeEqual(candidate, stored)) {
      throw new Error("TOKEN_LEDGER_BINDING_INVALID");
    }
    if (record.status !== "ACTIVE" || record.revokedAtMs !== null ||
        now < record.notBeforeMs || now >= record.expiresAtMs) return null;
    return Object.freeze({ customerId: record.customerId });
  }
}
