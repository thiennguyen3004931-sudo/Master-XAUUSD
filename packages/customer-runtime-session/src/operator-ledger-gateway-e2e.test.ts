import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CustomerApiGateway,
  InMemoryFixedWindowCustomerApiRateLimiter,
  sha256CustomerApiToken,
  type CustomerApiGatewayDependencies,
} from "./api-gateway.js";
import { LedgerCustomerApiKeyAuthenticator } from "./api-token-lifecycle.js";
import { initializeEmptyOperatorTokenLedger, OperatorSqliteCustomerTokenLedger } from "./operator-token-ledger.js";

/** No customer host, MT5, real token or operator service is involved. */
const NOW = 1_900_000_000_000;
const TOKEN = "synthetic-gateway-operator-token-not-a-secret";
const DIGEST = sha256CustomerApiToken(TOKEN);
const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xau-ledger-gateway-e2e-"));
  tempRoots.push(root);
  const operatorDir = join(root, "operator-only");
  const customerDir = join(root, "customer-restorable");
  mkdirSync(operatorDir);
  mkdirSync(customerDir);
  const path = join(operatorDir, "tokens.sqlite");
  initializeEmptyOperatorTokenLedger(path);
  const ledger = new OperatorSqliteCustomerTokenLedger(path);
  const deps = {
    grants: { get: async () => null },
    licenses: { get: async () => null },
    challenges: {},
    clock: { now: () => NOW },
    authenticator: new LedgerCustomerApiKeyAuthenticator(ledger, { now: () => NOW }),
    rateLimiter: new InMemoryFixedWindowCustomerApiRateLimiter(),
  } as unknown as CustomerApiGatewayDependencies;
  return { root, path, ledger, gateway: new CustomerApiGateway(deps) };
}

function request(mode: "SELF_MANAGED" | "COPY_FOLLOWER", path: string) {
  return {
    method: "POST",
    path,
    authorization: "Bearer " + TOKEN,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify({
      productMode: mode,
      grantId: "synthetic-grant",
      installationId: "synthetic-install",
    }),
  };
}

describe("physical operator ledger → Gateway auth boundary (synthetic only)", () => {
  for (const mode of ["SELF_MANAGED", "COPY_FOLLOWER"] as const) {
    it(mode + ": active token reaches grant check; revoke survives restart and customer rollback", async () => {
      const f = fixture();
      const oldCustomer = join(f.root, "customer-restorable", "old.sqlite");
      const restoredCustomer = join(f.root, "customer-restorable", "restored.sqlite");
      writeFileSync(oldCustomer, "synthetic customer snapshot only");
      expect(await f.ledger.registerToken({
        tokenSha256Hex: DIGEST,
        customerId: "synthetic-customer",
        status: "ACTIVE",
        notBeforeMs: NOW - 1000,
        expiresAtMs: NOW + 60_000,
        revokedAtMs: null,
        generation: 1,
      })).toBe(true);
      const req = request(mode, "/v1/customer/runtime/challenge");
      // Active auth succeeded; no grant is configured, so authorization must deny.
      const active = await f.gateway.handle(req);
      expect(active.status).toBe(403);
      expect(JSON.parse(active.body).code).toBe("AUTHORIZATION_DENIED");

      expect(await f.ledger.revokeToken(DIGEST, 1, NOW)).toBe(true);
      copyFileSync(oldCustomer, restoredCustomer);
      const revoked = await f.gateway.handle(req);
      expect(revoked.status).toBe(401);
      expect(JSON.parse(revoked.body).code).toBe("UNAUTHORIZED");
      expect(revoked.body).not.toContain(TOKEN);
      expect(revoked.body).not.toContain(DIGEST);

      // The original authenticator reads the same independently stored
      // record per request; new Gateway instances also reject after restart.
      f.ledger.close();
      const reopened = new OperatorSqliteCustomerTokenLedger(f.path);
      const restarted = new CustomerApiGateway({
        grants: { get: async () => null },
        licenses: { get: async () => null },
        challenges: {},
        clock: { now: () => NOW },
        authenticator: new LedgerCustomerApiKeyAuthenticator(reopened, { now: () => NOW }),
        rateLimiter: new InMemoryFixedWindowCustomerApiRateLimiter(),
      } as unknown as CustomerApiGatewayDependencies);
      expect((await restarted.handle(req)).status).toBe(401);
      reopened.close();
      // A dead operator ledger must not silently fall back to customer state.
      const outage = await restarted.handle(req);
      expect(outage.status).toBe(503);
      expect(JSON.parse(outage.body).code).toBe("AUTH_SOURCE_UNAVAILABLE");
      expect(outage.body).not.toContain(TOKEN);
    });
  }
});
