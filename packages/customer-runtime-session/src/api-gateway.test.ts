import { describe, expect, it } from "vitest";
import {
  InMemoryCustomerGrantRegistryRepository,
  registerCustomerGrant,
} from "@xauusd/customer-grant-registry";
import {
  createCustomerProductGrantLifecycle,
  issueCopyFollowerGrant,
  issueSelfManagedGrant,
} from "@xauusd/customer-product-access";
import type { CustomerLicenseResolver } from "@xauusd/customer-runtime-gate";
import {
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  signInstallationProof,
  type InstallationChallenge,
} from "@xauusd/installation-proof";
import type { LicenseRecord } from "@xauusd/license-service";
import {
  CustomerApiGateway,
  InMemoryFixedWindowCustomerApiRateLimiter,
  Sha256CustomerApiKeyAuthenticator,
  sha256CustomerApiToken,
  CUSTOMER_API_MAX_BODY_BYTES,
} from "./api-gateway.js";
import { InMemoryCustomerRuntimeChallengeStore } from "./session.js";
import { LedgerCustomerApiKeyAuthenticator, type CustomerApiTokenLifecycleRecord } from "./api-token-lifecycle.js";
import type { CustomerApiAuthenticator } from "./api-gateway.js";

const NOW = 15_000_000;
const TOKEN = "customer-api-token-001";

class MutableClock {
  constructor(public value = NOW) {}
  now() {
    return this.value;
  }
}

function fixture() {
  const keys = generateInstallationDeviceKeyPair();
  const license: LicenseRecord = {
    licenseId: "license-api-001",
    status: "ACTIVE",
    customerId: "customer-api-001",
    allowedMt5Logins: [660001],
    allowedBrokerServers: ["Broker-Real"],
    installationId: "install-api-001",
    installationPublicKey: exportInstallationPublicKey(keys.publicKey),
    plan: "CUSTOMER_V1",
    maxAccounts: 1,
    issuedAt: NOW - 100_000,
    expiresAt: NOW + 500_000,
    revokedAt: null,
  };
  return { license, keys };
}

function resolver(license: LicenseRecord): CustomerLicenseResolver {
  return {
    async get(licenseId) {
      return licenseId === license.licenseId ? license : null;
    },
  };
}

function authenticator(customerId = "customer-api-001") {
  return new Sha256CustomerApiKeyAuthenticator([
    {
      customerId,
      tokenSha256Hex: sha256CustomerApiToken(TOKEN),
    },
  ]);
}

function request(
  path: string,
  body: unknown,
  authorization = `Bearer ${TOKEN}`,
) {
  return {
    method: "POST",
    path,
    authorization,
    contentType: "application/json",
    remoteAddress: "127.0.0.1",
    body: JSON.stringify(body),
  };
}

async function selfManagedGateway(
  rateLimiter = new InMemoryFixedWindowCustomerApiRateLimiter(),
  customerId = "customer-api-001",
  tokenAuthenticator?: CustomerApiAuthenticator,
) {
  const registry = new InMemoryCustomerGrantRegistryRepository();
  const store = new InMemoryCustomerRuntimeChallengeStore();
  const clock = new MutableClock();
  const { license, keys } = fixture();
  const lifecycle = createCustomerProductGrantLifecycle(
    issueSelfManagedGrant(license, {
      grantId: "grant-api-self",
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 180_000,
      allowedBotModes: ["AUTO"],
    }),
  );
  expect(await registerCustomerGrant(registry, lifecycle)).toMatchObject({
    ok: true,
  });

  return {
    gateway: new CustomerApiGateway({
      grants: registry,
      licenses: resolver(license),
      challenges: store,
      clock,
      authenticator: tokenAuthenticator ?? authenticator(customerId),
      rateLimiter,
    }),
    clock,
    license,
    keys,
  };
}

describe("CustomerApiGateway", () => {
  it("authenticates, issues SELF_MANAGED challenge, activates once, and rejects replay", async () => {
    const { gateway, license, keys } = await selfManagedGateway();

    const challengeResponse = await gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: license.installationId,
      }),
    );
    expect(challengeResponse.status).toBe(200);

    const challengeDecision = JSON.parse(challengeResponse.body) as {
      ok: boolean;
      challenge: InstallationChallenge;
    };
    expect(challengeDecision.ok).toBe(true);

    const proof = signInstallationProof({
      challenge: challengeDecision.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    const activationRequest = request("/v1/customer/runtime/activate", {
      productMode: "SELF_MANAGED",
      grantId: "grant-api-self",
      installationId: license.installationId,
      mt5Login: 660001,
      brokerServer: "Broker-Real",
      requestedBotMode: "AUTO",
      proof,
    });

    const activated = await gateway.handle(activationRequest);
    expect(activated.status).toBe(200);
    expect(JSON.parse(activated.body)).toMatchObject({
      ok: true,
      code: "ACTIVATED",
      productMode: "SELF_MANAGED",
      exposureAllowed: true,
    });

    const replay = await gateway.handle(activationRequest);
    expect(replay.status).toBe(403);
    expect(JSON.parse(replay.body)).toMatchObject({
      ok: false,
      code: "INSTALLATION_PROOF_DENIED",
    });
  });

  it("supports COPY_FOLLOWER challenge and activation without exposing master trading controls", async () => {
    const registry = new InMemoryCustomerGrantRegistryRepository();
    const store = new InMemoryCustomerRuntimeChallengeStore();
    const clock = new MutableClock();
    const { license, keys } = fixture();
    const lifecycle = createCustomerProductGrantLifecycle(
      issueCopyFollowerGrant(license, {
        grantId: "grant-api-copy",
        issuedAt: NOW - 1_000,
        expiresAt: NOW + 180_000,
        allowedCopySizingModes: ["EQUITY_RATIO"],
      }),
    );
    expect(await registerCustomerGrant(registry, lifecycle)).toMatchObject({
      ok: true,
    });

    const gateway = new CustomerApiGateway({
      grants: registry,
      licenses: resolver(license),
      challenges: store,
      clock,
      authenticator: authenticator(),
      rateLimiter: new InMemoryFixedWindowCustomerApiRateLimiter(),
    });

    const challengeResponse = await gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "COPY_FOLLOWER",
        grantId: "grant-api-copy",
        installationId: license.installationId,
      }),
    );
    expect(challengeResponse.status).toBe(200);
    const challengeDecision = JSON.parse(challengeResponse.body) as {
      challenge: InstallationChallenge;
    };

    const proof = signInstallationProof({
      challenge: challengeDecision.challenge,
      installationPublicKey: license.installationPublicKey,
      privateKey: keys.privateKey,
    });

    const activated = await gateway.handle(
      request("/v1/customer/runtime/activate", {
        productMode: "COPY_FOLLOWER",
        grantId: "grant-api-copy",
        installationId: license.installationId,
        mt5Login: 660001,
        brokerServer: "Broker-Real",
        requestedSizingMode: "EQUITY_RATIO",
        proof,
      }),
    );

    expect(activated.status).toBe(200);
    expect(JSON.parse(activated.body)).toMatchObject({
      ok: true,
      code: "ACTIVATED",
      productMode: "COPY_FOLLOWER",
      exposureAllowed: true,
    });
  });

  it("fails closed for missing authentication and cross-customer grant access", async () => {
    const correct = await selfManagedGateway();

    const unauthenticated = await correct.gateway.handle(
      request(
        "/v1/customer/runtime/challenge",
        {
          productMode: "SELF_MANAGED",
          grantId: "grant-api-self",
          installationId: correct.license.installationId,
        },
        "",
      ),
    );
    expect(unauthenticated.status).toBe(401);

    const wrongCustomer = await selfManagedGateway(
      new InMemoryFixedWindowCustomerApiRateLimiter(),
      "customer-other",
    );
    const denied = await wrongCustomer.gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: wrongCustomer.license.installationId,
      }),
    );
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({
      ok: false,
      code: "AUTHORIZATION_DENIED",
    });
  });

  it("rate-limits repeated callers and rejects oversized request bodies before activation", async () => {
    const limited = await selfManagedGateway(
      new InMemoryFixedWindowCustomerApiRateLimiter(1, 60_000),
    );

    const first = await limited.gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: limited.license.installationId,
      }),
    );
    expect(first.status).toBe(200);

    const second = await limited.gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: limited.license.installationId,
      }),
    );
    expect(second.status).toBe(429);

    const normal = await selfManagedGateway();
    const oversized = await normal.gateway.handle({
      method: "POST",
      path: "/v1/customer/runtime/challenge",
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
      remoteAddress: "127.0.0.2",
      body: "x".repeat(CUSTOMER_API_MAX_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
  });

  it("requires exact JSON schemas and JSON media type", async () => {
    const { gateway, license } = await selfManagedGateway();

    const extraField = await gateway.handle(
      request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: license.installationId,
        customerId: "caller-controlled-must-not-be-accepted",
      }),
    );
    expect(extraField.status).toBe(400);

    const wrongMedia = await gateway.handle({
      ...request("/v1/customer/runtime/challenge", {
        productMode: "SELF_MANAGED",
        grantId: "grant-api-self",
        installationId: license.installationId,
      }),
      contentType: "text/plain",
    });
    expect(wrongMedia.status).toBe(415);
  });

  it("dynamically revokes Gateway challenge access and fails closed on token ledger outage", async () => {
    let unavailable = false;
    const tokenDigest = sha256CustomerApiToken(TOKEN);
    const record: CustomerApiTokenLifecycleRecord = {
      customerId: "customer-api-001",
      tokenSha256Hex: tokenDigest,
      status: "ACTIVE",
      notBeforeMs: NOW - 100,
      expiresAtMs: NOW + 50_000,
      revokedAtMs: null,
      generation: 1,
    };
    const tokenRecords = new Map<string, CustomerApiTokenLifecycleRecord>([[tokenDigest, record]]);
    const tokenAuth = new LedgerCustomerApiKeyAuthenticator({
      async getBySha256(hash) {
        if (unavailable) throw new Error("synthetic ledger offline");
        return tokenRecords.get(hash) ?? null;
      },
    }, { now: () => NOW });
    const {gateway, license} = await selfManagedGateway(
      new InMemoryFixedWindowCustomerApiRateLimiter(),
      "customer-api-001",
      tokenAuth,
    );
    const challenge = request("/v1/customer/runtime/challenge", {
      productMode: "SELF_MANAGED",
      grantId: "grant-api-self",
      installationId: license.installationId,
    });
    expect((await gateway.handle(challenge)).status).toBe(200);
    tokenRecords.set(tokenDigest, {
      ...record,
      status: "REVOKED",
      revokedAtMs: NOW,
      generation: 2,
    });
    const revoked = await gateway.handle(challenge);
    expect(revoked.status).toBe(401);
    tokenRecords.set(tokenDigest, record);
    unavailable = true;
    const outage = await gateway.handle(challenge);
    expect(outage.status).toBe(503);
    expect(JSON.parse(outage.body)).toEqual({ok: false, code: "AUTH_SOURCE_UNAVAILABLE"});
    expect(outage.body).not.toContain(TOKEN);
    expect(outage.body).not.toContain(tokenDigest);
  });

});
