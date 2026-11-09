import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryCustomerGrantRegistryRepository,
  registerCustomerGrant,
} from "../packages/customer-grant-registry/dist/index.js";
import {
  createCustomerProductGrantLifecycle,
  issueSelfManagedGrant,
} from "../packages/customer-product-access/dist/index.js";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
} from "../packages/installation-proof/dist/index.js";
import {
  CustomerApiGateway,
  InMemoryCustomerRuntimeChallengeStore,
  InMemoryFixedWindowCustomerApiRateLimiter,
  Sha256CustomerApiKeyAuthenticator,
  sha256CustomerApiToken,
} from "../packages/customer-runtime-session/dist/index.js";

const NOW = 1_800_000_000_000;
const TOKEN = "restore-gate-test-token-001";

test("CustomerApiGateway blocks challenge and activate when restoreAdmissionGate denies or throws, and admits when allowed", async () => {
  const keys = generateInstallationDeviceKeyPair();
  const license = {
    licenseId: "lic-restore-gate-001",
    status: "ACTIVE",
    customerId: "cust-restore-gate-001",
    allowedMt5Logins: [880001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "inst-restore-gate-001",
    installationPublicKey: exportInstallationPublicKey(keys.publicKey),
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 10_000,
    expiresAt: NOW + 500_000,
    revokedAt: null,
  };
  const lifecycle = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: "grant-restore-gate-001",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 200_000,
      allowedBotModes: ["PAUSE", "AUTO"],
    }),
  );

  const grants = new InMemoryCustomerGrantRegistryRepository();
  await registerCustomerGrant(grants, lifecycle);
  const challenges = new InMemoryCustomerRuntimeChallengeStore();

  let admissionDecision = { allowed: false, reasonCode: "RESTORE_GENERATION_ROLLBACK" };

  const gateway = new CustomerApiGateway({
    grants,
    licenses: { async get(id) { return id === license.licenseId ? license : null; } },
    challenges,
    clock: { now: () => NOW },
    authenticator: new Sha256CustomerApiKeyAuthenticator([
      { customerId: "cust-restore-gate-001", tokenSha256Hex: sha256CustomerApiToken(TOKEN) },
    ]),
    rateLimiter: new InMemoryFixedWindowCustomerApiRateLimiter(100, 60_000),
    restoreAdmissionGate: {
      async admit() {
        return admissionDecision;
      },
    },
  });

  // 1. Denied challenge while quarantined
  const deniedChallenge = await gateway.handle({
    method: "POST",
    path: "/v1/customer/runtime/challenge",
    authorization: `Bearer ${TOKEN}`,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify({
      productMode: "SELF_MANAGED",
      grantId: "grant-restore-gate-001",
      installationId: "inst-restore-gate-001",
    }),
  });
  assert.equal(deniedChallenge.status, 503);
  assert.deepEqual(JSON.parse(deniedChallenge.body), {
    ok: false,
    code: "RESTORE_GENERATION_ROLLBACK",
  });

  // 2. Allow challenge, then quarantine before activate
  admissionDecision = { allowed: true };
  const allowedChallenge = await gateway.handle({
    method: "POST",
    path: "/v1/customer/runtime/challenge",
    authorization: `Bearer ${TOKEN}`,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify({
      productMode: "SELF_MANAGED",
      grantId: "grant-restore-gate-001",
      installationId: "inst-restore-gate-001",
    }),
  });
  assert.equal(allowedChallenge.status, 200);
  const { challenge } = JSON.parse(allowedChallenge.body);
  const proof = signInstallationProof({
    challenge,
    installationPublicKey: license.installationPublicKey,
    privateKey: keys.privateKey,
  });

  admissionDecision = { allowed: false, reasonCode: "RESTORE_ADMISSION_QUARANTINED" };
  const deniedActivate = await gateway.handle({
    method: "POST",
    path: "/v1/customer/runtime/activate",
    authorization: `Bearer ${TOKEN}`,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify({
      productMode: "SELF_MANAGED",
      grantId: "grant-restore-gate-001",
      installationId: "inst-restore-gate-001",
      mt5Login: 880001,
      brokerServer: "Broker-Real",
      requestedBotMode: "PAUSE",
      proof,
    }),
  });
  assert.equal(deniedActivate.status, 503);
  assert.deepEqual(JSON.parse(deniedActivate.body), {
    ok: false,
    code: "RESTORE_ADMISSION_QUARANTINED",
  });

  // 3. Allow activate when restore gate passes
  admissionDecision = { allowed: true };
  const allowedActivate = await gateway.handle({
    method: "POST",
    path: "/v1/customer/runtime/activate",
    authorization: `Bearer ${TOKEN}`,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify({
      productMode: "SELF_MANAGED",
      grantId: "grant-restore-gate-001",
      installationId: "inst-restore-gate-001",
      mt5Login: 880001,
      brokerServer: "Broker-Real",
      requestedBotMode: "PAUSE",
      proof,
    }),
  });
  assert.equal(allowedActivate.status, 200);
  assert.equal(JSON.parse(allowedActivate.body).ok, true);
});
