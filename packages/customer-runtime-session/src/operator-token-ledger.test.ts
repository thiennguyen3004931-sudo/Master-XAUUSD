import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerCustomerApiKeyAuthenticator, type CustomerApiTokenLifecycleRecord } from "./api-token-lifecycle.js";
import { sha256CustomerApiToken } from "./api-gateway.js";
import { initializeEmptyOperatorTokenLedger, OperatorSqliteCustomerTokenLedger } from "./operator-token-ledger.js";

const NOW = 1_900_000_000_000;
const TOKEN = "synthetic-token-a-do-not-use-in-production";
const TOKEN_NEW = "synthetic-token-b-do-not-use-in-production";
const HASH = sha256CustomerApiToken(TOKEN);
const HASH_NEW = sha256CustomerApiToken(TOKEN_NEW);
const locations: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xau-operator-token-ledger-"));
  locations.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of locations.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
});
function fresh() {
  const root = tempDir();
  const operatorPath = join(root, "operator", "tokens.sqlite");
  mkdirSync(join(root, "operator"));
  mkdirSync(join(root, "customer-restorable"));
  initializeEmptyOperatorTokenLedger(operatorPath);
  return { root, operatorPath, ledger: new OperatorSqliteCustomerTokenLedger(operatorPath) };
}
const record = (tokenSha256Hex = HASH): CustomerApiTokenLifecycleRecord => ({
  tokenSha256Hex, customerId: "customer-1", status: "ACTIVE",
  notBeforeMs: NOW - 1000, expiresAtMs: NOW + 60_000,
  revokedAtMs: null, generation: 1,
});
const auth = (ledger: OperatorSqliteCustomerTokenLedger, now: () => number = () => NOW) =>
  new LedgerCustomerApiKeyAuthenticator(ledger, { now });

describe("OperatorSqliteCustomerTokenLedger (isolated synthetic data only)", () => {
  it("persists registered token across connection reopen", async () => {
    const {operatorPath,ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.registerToken(record())).toBe(false);
    ledger.close();
    const reopened = new OperatorSqliteCustomerTokenLedger(operatorPath);
    expect(await auth(reopened).authenticate(TOKEN)).toEqual({customerId:"customer-1"});
    reopened.close();
  });

  it("revocation survives restart and cannot be silently re-registered", async () => {
    const {operatorPath,ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.revokeToken(HASH,1,NOW)).toBe(true);
    expect(await ledger.revokeToken(HASH,1,NOW + 1)).toBe(false);
    expect(await ledger.registerToken(record())).toBe(false);
    ledger.close();
    const reopened = new OperatorSqliteCustomerTokenLedger(operatorPath);
    expect(await auth(reopened).authenticate(TOKEN)).toBeNull();
    expect((await reopened.getBySha256(HASH))?.generation).toBe(2);
    reopened.close();
  });

  it("stale generation conflict and renewal with a new digest", async () => {
    const {ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.registerToken(record(HASH_NEW))).toBe(true);
    expect(await ledger.revokeToken(HASH,7,NOW)).toBe(false);
    expect(await ledger.revokeToken(HASH,1,NOW)).toBe(true);
    expect(await auth(ledger).authenticate(TOKEN)).toBeNull();
    expect(await auth(ledger).authenticate(TOKEN_NEW)).toEqual({customerId:"customer-1"});
    ledger.close();
  });

  it("old customer security snapshot cannot restore operator token approval", async () => {
    const {root,operatorPath,ledger} = fresh();
    const oldCustomerPath = join(root,"customer-restorable","customer.sqlite");
    writeFileSync(oldCustomerPath,"synthetic stale customer snapshot");
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.revokeToken(HASH,1,NOW)).toBe(true);
    copyFileSync(oldCustomerPath,join(root,"customer-restorable","restored.sqlite"));
    ledger.close();
    const again = new OperatorSqliteCustomerTokenLedger(operatorPath);
    expect(await auth(again).authenticate(TOKEN)).toBeNull();
    again.close();
  });

  it("missing and malformed operator stores reject instead of silently initialize", () => {
    const dir=tempDir(), absent=join(dir,"missing.sqlite"),invalid=join(dir,"invalid.sqlite");
    expect(()=>new OperatorSqliteCustomerTokenLedger(absent)).toThrow("OPERATOR_LEDGER_FILE_INVALID");
    writeFileSync(invalid,"not a sqlite database");
    expect(()=>new OperatorSqliteCustomerTokenLedger(invalid)).toThrow("OPERATOR_LEDGER_OPEN_FAILED");
  });

  it("initialization is exclusive and never overwrites existing authority", () => {
    const {operatorPath,ledger}=fresh();
    expect(()=>initializeEmptyOperatorTokenLedger(operatorPath)).toThrow("OPERATOR_LEDGER_INITIALIZATION_DENIED");
    ledger.close();
  });

  it("malformed/expired token does not authenticate", async () => {
    const {ledger}=fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await auth(ledger,()=>NOW+60_000).authenticate(TOKEN)).toBeNull();
    expect(await auth(ledger).authenticate("incorrect")).toBeNull();
    ledger.close();
  });

  it("rejects invalid registration and stale revocation inputs", async () => {
    const {ledger}=fresh();
    expect(await ledger.registerToken({...record(),generation:0})).toBe(false);
    expect(await ledger.registerToken({...record(),status:"REVOKED",revokedAtMs:NOW})).toBe(false);
    expect(await ledger.revokeToken(HASH,-1,NOW)).toBe(false);
    expect(await ledger.revokeToken(HASH,1,-1)).toBe(false);
    ledger.close();
  });

  it("revocation survives another reader initialized before commit", async () => {
    const {operatorPath,ledger}=fresh();
    const second = new OperatorSqliteCustomerTokenLedger(operatorPath);
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await auth(second).authenticate(TOKEN)).not.toBeNull();
    expect(await ledger.revokeToken(HASH,1,NOW)).toBe(true);
    expect(await auth(second).authenticate(TOKEN)).toBeNull();
    second.close();
    ledger.close();
  });
  it("atomic rotation supports a bounded two-token overlap and deterministic old expiry", async () => {
    const {operatorPath, ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.rotateToken(HASH, record(HASH_NEW), 1, NOW, 1000)).toBe(true);
    expect(await auth(ledger).authenticate(TOKEN)).not.toBeNull();
    expect(await auth(ledger).authenticate(TOKEN_NEW)).not.toBeNull();
    expect(await auth(ledger, () => NOW + 1000).authenticate(TOKEN)).toBeNull();
    expect(await auth(ledger, () => NOW + 1000).authenticate(TOKEN_NEW)).not.toBeNull();
    ledger.close();
    const again = new OperatorSqliteCustomerTokenLedger(operatorPath);
    expect(await auth(again, () => NOW + 1001).authenticate(TOKEN)).toBeNull();
    expect(await auth(again, () => NOW + 1001).authenticate(TOKEN_NEW)).not.toBeNull();
    again.close();
  });

  it("zero-overlap rotation revokes old token in the same transaction", async () => {
    const {ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.rotateToken(HASH, record(HASH_NEW), 1, NOW, 0)).toBe(true);
    expect((await ledger.getBySha256(HASH))?.status).toBe("REVOKED");
    expect(await auth(ledger).authenticate(TOKEN)).toBeNull();
    expect(await auth(ledger).authenticate(TOKEN_NEW)).not.toBeNull();
    ledger.close();
  });

  it("failed rotation never registers replacement token or modifies old token", async () => {
    const {ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.rotateToken(HASH, record(HASH_NEW), 99, NOW, 2000)).toBe(false);
    expect(await ledger.getBySha256(HASH_NEW)).toBeNull();
    expect((await ledger.getBySha256(HASH))?.generation).toBe(1);
    expect(await ledger.rotateToken(HASH, {...record(HASH_NEW), customerId:"other"}, 1, NOW, 2000)).toBe(false);
    expect(await ledger.getBySha256(HASH_NEW)).toBeNull();
    expect((await ledger.getBySha256(HASH))?.generation).toBe(1);
    ledger.close();
  });

  it("atomic rotation refuses overlap exceeding maximum", async () => {
    const {ledger} = fresh();
    expect(await ledger.registerToken(record())).toBe(true);
    expect(await ledger.rotateToken(HASH,record(HASH_NEW),1,NOW,60001)).toBe(false);
    expect(await ledger.getBySha256(HASH_NEW)).toBeNull();
    ledger.close();
  });

});
