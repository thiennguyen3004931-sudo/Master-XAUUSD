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
} from "../packages/customer-grant-registry/dist/index.js";
import {
  createInstallationChallenge,
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

const NOW = 70_000_000;
const TOKEN = "migration-e2e-token";
const CUSTOMER_ID = "customer-migration-e2e";

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
      remoteAddress: "127.0.0.20",
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: JSON.parse(response.body),
    };
  }
}

function license(licenseId, installationId, installationPublicKey) {
  return {
    licenseId,
    status: "ACTIVE",
    customerId: CUSTOMER_ID,
    allowedMt5Logins: [990001],
    allowedBrokerServers: ["Broker-Real"],
    installationId,
    installationPublicKey,
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 1_000_000,
    revokedAt: null,
  };
}

function gatewayFor(store, clock) {
  return new CustomerApiGateway({
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
}

function agentFor(gateway, grantId, currentLicense, keys) {
  return new CustomerAgent(
    new InProcessGatewayTransport(gateway),
    {
      apiToken: TOKEN,
      grantId,
      installationId: currentLicense.installationId,
      installationPublicKey: currentLicense.installationPublicKey,
      installationPrivateKey: keys.privateKey,
      mt5Login: 990001,
      brokerServer: "Broker-Real",
    },
    { async sleep() {} },
  );
}

test("revoke/new-PC migration survives restart and fails closed on old machine", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xauusd-migrate-e2e-"));
  const dbPath = path.join(directory, "customer-security.sqlite");
  const clock = new MutableClock();
  const oldKeys = generateInstallationDeviceKeyPair();
  const newKeys = generateInstallationDeviceKeyPair();

  const oldLicense = license(
    "license-migrate-old",
    "installation-old-pc",
    exportInstallationPublicKey(oldKeys.publicKey),
  );
  const newLicense = license(
    "license-migrate-new",
    "installation-new-pc",
    exportInstallationPublicKey(newKeys.publicKey),
  );

  const oldGrant = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(oldLicense, {
      grantId: "grant-migrate-old",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 500_000,
      allowedBotModes: ["AUTO"],
    }),
  );
  const newGrant = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(newLicense, {
      grantId: "grant-migrate-new",
      issuedAt: NOW,
      expiresAt: NOW + 500_000,
      allowedBotModes: ["AUTO"],
    }),
  );

  const initial = new SqliteCustomerSecurityStore(dbPath);
  await initial.licenses.put(oldLicense);
  assert.equal((await registerCustomerGrant(initial.grants, oldGrant)).ok, true);

  const oldOutstandingChallenge = createInstallationChallenge({
    purpose: "RECONNECT",
    licenseId: oldLicense.licenseId,
    installationId: oldLicense.installationId,
    now: NOW - 100,
    ttlMs: 60_000,
  });
  assert.equal(
    await initial.challenges.put(oldOutstandingChallenge),
    true,
  );

  const beforeGateway = gatewayFor(initial, clock);
  const oldAgentBefore = agentFor(
    beforeGateway,
    oldGrant.grant.grantId,
    oldLicense,
    oldKeys,
  );
  assert.equal((await oldAgentBefore.activateSelfManaged("AUTO")).ok, true);

  clock.value += 10;
  const migration = await initial.migrateInstallation({
    oldGrantId: oldGrant.grant.grantId,
    newLicense,
    newGrant,
    migratedAt: clock.value,
    authorizedBy: "customer-admin-service",
  });
  assert.equal(migration.ok, true);
  assert.equal(migration.code, "MIGRATED");
  assert.ok(migration.invalidatedChallenges >= 1);

  assert.equal(
    await initial.challenges.consume(
      oldOutstandingChallenge.challengeId,
      clock.value + 1,
    ),
    false,
  );

  initial.close();

  const reopened = new SqliteCustomerSecurityStore(dbPath);
  clock.value += 1;
  const afterGateway = gatewayFor(reopened, clock);

  const oldAgent = agentFor(
    afterGateway,
    oldGrant.grant.grantId,
    oldLicense,
    oldKeys,
  );
  const blockedOld = await oldAgent.activateSelfManaged("AUTO");
  assert.equal(blockedOld.ok, false);
  assert.equal(blockedOld.code, "GATEWAY_REJECTED");
  assert.equal(blockedOld.status, 403);

  const newAgent = agentFor(
    afterGateway,
    newGrant.grant.grantId,
    newLicense,
    newKeys,
  );
  const newActivation = await newAgent.activateSelfManaged("AUTO");
  assert.equal(newActivation.ok, true);
  assert.equal(newActivation.decision.code, "ACTIVATED");
  assert.equal(newActivation.decision.exposureAllowed, true);

  const audit = await reopened.listInstallationMigrationAudit(CUSTOMER_ID);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].oldInstallationId, oldLicense.installationId);
  assert.equal(audit[0].newInstallationId, newLicense.installationId);
  assert.equal(audit[0].authorizedBy, "customer-admin-service");

  reopened.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
