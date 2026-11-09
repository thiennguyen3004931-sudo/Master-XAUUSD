import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  signCopyCommand,
} from "../packages/copy-protocol/dist/index.js";
import {
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
} from "../packages/customer-product-access/dist/index.js";
import {
  registerCustomerGrant,
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
import {
  CustomerAgent,
  CustomerCopyCommandVerifier,
} from "../packages/customer-agent/dist/index.js";

const NOW = 50_000_000;
const TOKEN = "copy-follower-e2e-token";
const WRONG_TOKEN = "copy-follower-other-customer";
const CUSTOMER_ID = "customer-copy-e2e";
const LICENSE_ID = "license-copy-e2e";
const INSTALLATION_ID = "install-copy-e2e";
const GRANT_ID = "grant-copy-e2e";

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
  }

  async post(requestPath, bearerToken, body) {
    const response = await this.gateway.handle({
      method: "POST",
      path: requestPath,
      authorization: `Bearer ${bearerToken}`,
      contentType: "application/json",
      remoteAddress: "127.0.0.10",
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: JSON.parse(response.body),
    };
  }
}

test("COPY_FOLLOWER handoff E2E authenticates and verifies signed commands without MT5 execution", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xauusd-copy-e2e-"));
  const databasePath = path.join(directory, "customer-security.sqlite");
  const installationKeys = generateInstallationDeviceKeyPair();
  const installationPublicKey = exportInstallationPublicKey(
    installationKeys.publicKey,
  );
  const masterKeys = generateKeyPairSync("ed25519");
  const masterPrivateKeyPem = masterKeys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const masterPublicKeyPem = masterKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const clock = new MutableClock();

  const license = {
    licenseId: LICENSE_ID,
    status: "ACTIVE",
    customerId: CUSTOMER_ID,
    allowedMt5Logins: [220001],
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
    issueCopyFollowerGrant(license, {
      grantId: GRANT_ID,
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 500_000,
      allowedCopySizingModes: ["EQUITY_RATIO"],
    }),
  );

  const store = new SqliteCustomerSecurityStore(databasePath);
  await store.licenses.put(license);
  assert.equal(
    (await registerCustomerGrant(store.grants, lifecycle)).ok,
    true,
  );

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
      {
        customerId: "customer-other",
        tokenSha256Hex: sha256CustomerApiToken(WRONG_TOKEN),
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
      installationPrivateKey: installationKeys.privateKey,
      mt5Login: 220001,
      brokerServer: "Broker-Real",
    },
    { async sleep() {} },
  );

  const activated = await agent.activateCopyFollower("EQUITY_RATIO");
  assert.equal(activated.ok, true);
  assert.equal(activated.productMode, "COPY_FOLLOWER");
  assert.equal(activated.decision.code, "ACTIVATED");

  const wrongCustomerAgent = new CustomerAgent(
    transport,
    {
      apiToken: WRONG_TOKEN,
      grantId: GRANT_ID,
      installationId: INSTALLATION_ID,
      installationPublicKey,
      installationPrivateKey: installationKeys.privateKey,
      mt5Login: 220001,
      brokerServer: "Broker-Real",
    },
    { async sleep() {} },
  );
  const unauthorized = await wrongCustomerAgent.activateCopyFollower(
    "EQUITY_RATIO",
  );
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, "GATEWAY_REJECTED");
  assert.equal(unauthorized.status, 403);

  const verifier = new CustomerCopyCommandVerifier(
    {
      licenseId: LICENSE_ID,
      installationId: INSTALLATION_ID,
      mt5Login: 220001,
      brokerServer: "Broker-Real",
      allowedSymbols: ["XAUUSD"],
    },
    new Map([["master-copy-key-001", masterPublicKeyPem]]),
    clock,
  );

  const commandBody = {
    version: 1,
    commandId: "copy-command-e2e-001",
    sequence: 1,
    licenseId: LICENSE_ID,
    installationId: INSTALLATION_ID,
    mt5Login: 220001,
    brokerServer: "Broker-Real",
    symbol: "XAUUSD",
    action: "POSITION_OPEN",
    payload: {
      side: "BUY",
      volume: 0.1,
      entry: 4200,
      stopLoss: 4190,
    },
    masterPositionRef: "master-position-e2e-001",
    issuedAt: NOW - 10,
    expiresAt: NOW + 30_000,
    keyId: "master-copy-key-001",
  };

  const command = signCopyCommand(commandBody, masterPrivateKeyPem);
  assert.deepEqual(verifier.accept(command), {
    ok: true,
    code: "ACCEPTED",
    command,
  });

  assert.deepEqual(verifier.accept(command), {
    ok: false,
    code: "REPLAYED_COMMAND",
  });

  const wrongInstallationCommand = signCopyCommand(
    {
      ...commandBody,
      commandId: "copy-command-e2e-002",
      sequence: 2,
      installationId: "install-other",
    },
    masterPrivateKeyPem,
  );
  assert.deepEqual(verifier.accept(wrongInstallationCommand), {
    ok: false,
    code: "BINDING_MISMATCH",
  });

  store.close();
  rmSync(directory, { recursive: true, force: true });
});
