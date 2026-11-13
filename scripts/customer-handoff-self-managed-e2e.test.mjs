import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCustomerProductGrantLifecycle,
  issueSelfManagedGrant,
} from "../packages/customer-product-access/dist/index.js";
import {
  registerCustomerGrant,
  revokeRegisteredCustomerGrant,
} from "../packages/customer-grant-registry/dist/index.js";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
} from "../packages/installation-proof/dist/index.js";
import {
  CustomerApiGateway,
  InMemoryFixedWindowCustomerApiRateLimiter,
  Sha256CustomerApiKeyAuthenticator,
  SqliteCustomerSecurityStore,
  sha256CustomerApiToken,
} from "../packages/customer-runtime-session/dist/index.js";
import { CustomerAgent } from "../packages/customer-agent/dist/index.js";

const NOW = 30_000_000;
const TOKEN = "self-managed-e2e-token";
const CUSTOMER_ID = "customer-self-e2e";
const LICENSE_ID = "license-self-e2e";
const INSTALLATION_ID = "install-self-e2e";
const GRANT_ID = "grant-self-e2e";

class MutableClock {
  constructor(value = NOW) {
    this.value = value;
  }
  now() {
    return this.value;
  }
}

class InProcessGatewayTransport {
  constructor(gateway) {
    this.gateway = gateway;
    this.calls = [];
  }

  async post(requestPath, bearerToken, body) {
    this.calls.push({ requestPath, bearerToken, body });
    const response = await this.gateway.handle({
      method: "POST",
      path: requestPath,
      authorization: `Bearer ${bearerToken}`,
      contentType: "application/json",
      remoteAddress: "127.0.0.1",
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: JSON.parse(response.body),
    };
  }
}

test("SELF_MANAGED customer handoff E2E is fail-closed and replay-safe", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xauusd-self-e2e-"));
  const databasePath = path.join(directory, "customer-security.sqlite");
  const keys = generateInstallationDeviceKeyPair();
  const installationPublicKey = exportInstallationPublicKey(keys.publicKey);
  const clock = new MutableClock();

  const license = {
    licenseId: LICENSE_ID,
    status: "ACTIVE",
    customerId: CUSTOMER_ID,
    allowedMt5Logins: [440001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: INSTALLATION_ID,
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 1_000_000,
    revokedAt: null,
  };

  const lifecycle = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: GRANT_ID,
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 500_000,
      allowedBotModes: ["AUTO"],
    }),
  );

  const initial = new SqliteCustomerSecurityStore(databasePath);
  await initial.licenses.put(license);
  assert.equal(
    (await registerCustomerGrant(initial.grants, lifecycle)).ok,
    true,
  );
  initial.close();

  const store = new SqliteCustomerSecurityStore(databasePath);
  const gateway = new CustomerApiGateway({
    grants: store.grants,
    licenses: store.licenses,
    challenges: store.challenges,
    clock,
    authenticator: new Sha256CustomerApiKeyAuthenticator([
      {
        customerId: CUSTOMER_ID,
        tokenSha256Hex: sha256CustomerApiToken(TOKEN),
      },
    ]),
    rateLimiter: new InMemoryFixedWindowCustomerApiRateLimiter(100, 60_000),
  });
  const transport = new InProcessGatewayTransport(gateway);
  const agent = new CustomerAgent(
    transport,
    {
      apiToken: TOKEN,
      grantId: GRANT_ID,
      installationId: INSTALLATION_ID,
      installationPublicKey,
      installationPrivateKey: keys.privateKey,
      mt5Login: 440001,
      brokerServer: "Broker-Real",
    },
    { async sleep() {} },
  );

  const auto = await agent.activateSelfManaged("AUTO");
  assert.equal(auto.ok, true);
  assert.equal(auto.productMode, "SELF_MANAGED");
  assert.equal(auto.decision.code, "ACTIVATED");
  assert.equal(auto.decision.exposureAllowed, true);

  const activationCall = transport.calls.find(
    (call) => call.requestPath === "/v1/customer/runtime/activate",
  );
  assert.ok(activationCall, "activation call must be captured");

  const replay = await gateway.handle({
    method: "POST",
    path: "/v1/customer/runtime/activate",
    authorization: `Bearer ${TOKEN}`,
    contentType: "application/json",
    remoteAddress: "127.0.0.2",
    body: JSON.stringify(activationCall.body),
  });
  assert.equal(replay.status, 403);
  assert.equal(JSON.parse(replay.body).code, "INSTALLATION_PROOF_DENIED");

  clock.value += 10;
  const revoked = await revokeRegisteredCustomerGrant(
    store.grants,
    GRANT_ID,
    clock.value,
  );
  assert.equal(revoked.ok, true);

  clock.value += 1;
  const blockedAuto = await agent.activateSelfManaged("AUTO");
  assert.equal(blockedAuto.ok, false);
  assert.equal(blockedAuto.code, "GATEWAY_REJECTED");
  assert.equal(blockedAuto.status, 403);

  const safePause = await agent.activateSelfManaged("PAUSE");
  assert.equal(safePause.ok, true);
  assert.equal(safePause.decision.code, "ACTIVATED");
  assert.equal(safePause.decision.exposureAllowed, false);
  assert.equal(safePause.decision.accessCode, "AUTHORIZED_SAFE_PAUSE");

  store.close();
  rmSync(directory, { recursive: true, force: true });
});
