import { describe, expect, it } from "vitest";
import {
  createInstallationChallenge,
  exportInstallationPublicKey,
  generateInstallationDeviceKeyPair,
  verifyInstallationProofSignature,
  type InstallationChallenge,
} from "@xauusd/installation-proof";
import {
  CustomerAgent,
  type CustomerAgentSleeper,
  type CustomerAgentTransport,
  type CustomerAgentTransportResponse,
} from "./agent.js";

const NOW = 20_000_000;
const TOKEN = "agent-token-001";

function identity() {
  const keys = generateInstallationDeviceKeyPair();
  return {
    keys,
    identity: {
      apiToken: TOKEN,
      grantId: "grant-agent-001",
      installationId: "install-agent-001",
      installationPublicKey: exportInstallationPublicKey(keys.publicKey),
      installationPrivateKey: keys.privateKey,
      mt5Login: 550001,
      brokerServer: "Broker-Real",
    },
  };
}

function challenge(
  installationId = "install-agent-001",
): InstallationChallenge {
  return createInstallationChallenge({
    purpose: "RECONNECT",
    licenseId: "license-agent-001",
    installationId,
    now: NOW,
    ttlMs: 60_000,
  });
}

class FakeGatewayTransport implements CustomerAgentTransport {
  readonly calls: Array<{
    path: string;
    token: string;
    body: Readonly<Record<string, unknown>>;
  }> = [];

  constructor(
    private readonly challengeValue = challenge(),
    private readonly transientFailures = 0,
  ) {}

  private attempts = 0;

  async post(
    path: string,
    bearerToken: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CustomerAgentTransportResponse> {
    this.calls.push({ path, token: bearerToken, body });
    this.attempts += 1;

    if (this.attempts <= this.transientFailures) {
      return { status: 503, body: { ok: false, code: "TEMPORARY" } };
    }

    if (path === "/v1/customer/runtime/challenge") {
      return {
        status: 200,
        body: {
          ok: true,
          code: "CHALLENGE_ISSUED",
          productMode: body.productMode,
          challenge: this.challengeValue,
        },
      };
    }

    if (path === "/v1/customer/runtime/activate") {
      const proof = body.proof;
      if (!verifyInstallationProofSignature(proof)) {
        return {
          status: 403,
          body: { ok: false, code: "INSTALLATION_PROOF_DENIED" },
        };
      }

      return {
        status: 200,
        body: {
          ok: true,
          code: "ACTIVATED",
          productMode: body.productMode,
          exposureAllowed: true,
        },
      };
    }

    return { status: 404, body: { ok: false, code: "NOT_FOUND" } };
  }
}

describe("CustomerAgent", () => {
  it("completes SELF_MANAGED challenge/proof/activation without master trading access", async () => {
    const fixture = identity();
    const transport = new FakeGatewayTransport();
    const agent = new CustomerAgent(transport, fixture.identity);

    await expect(agent.activateSelfManaged("AUTO")).resolves.toMatchObject({
      ok: true,
      status: 200,
      productMode: "SELF_MANAGED",
      decision: {
        code: "ACTIVATED",
        exposureAllowed: true,
      },
    });

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]).toMatchObject({
      path: "/v1/customer/runtime/challenge",
      token: TOKEN,
      body: {
        productMode: "SELF_MANAGED",
        grantId: "grant-agent-001",
        installationId: "install-agent-001",
      },
    });
    expect(transport.calls[1]?.body).toMatchObject({
      productMode: "SELF_MANAGED",
      requestedBotMode: "AUTO",
      mt5Login: 550001,
      brokerServer: "Broker-Real",
    });
  });

  it("completes COPY_FOLLOWER activation with an explicit sizing mode", async () => {
    const fixture = identity();
    const transport = new FakeGatewayTransport();
    const agent = new CustomerAgent(transport, fixture.identity);

    await expect(
      agent.activateCopyFollower("EQUITY_RATIO"),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      productMode: "COPY_FOLLOWER",
    });

    expect(transport.calls[1]?.body).toMatchObject({
      productMode: "COPY_FOLLOWER",
      requestedSizingMode: "EQUITY_RATIO",
    });
  });

  it("retries bounded transient failures before continuing the signed flow", async () => {
    const fixture = identity();
    const transport = new FakeGatewayTransport(challenge(), 1);
    const delays: number[] = [];
    const sleeper: CustomerAgentSleeper = {
      async sleep(ms) {
        delays.push(ms);
      },
    };
    const agent = new CustomerAgent(
      transport,
      fixture.identity,
      sleeper,
      3,
    );

    await expect(agent.activateSelfManaged("AUTO")).resolves.toMatchObject({
      ok: true,
    });
    expect(delays).toEqual([250]);
    expect(transport.calls).toHaveLength(3);
  });

  it("fails closed when the server challenge is bound to another installation", async () => {
    const fixture = identity();
    const transport = new FakeGatewayTransport(
      challenge("install-copied-machine"),
    );
    const agent = new CustomerAgent(transport, fixture.identity);

    await expect(agent.activateSelfManaged("AUTO")).resolves.toEqual({
      ok: false,
      code: "CHALLENGE_BINDING_MISMATCH",
      status: 200,
      decision: expect.any(Object),
    });
    expect(transport.calls).toHaveLength(1);
  });

  it("does not retry authorization denials", async () => {
    const fixture = identity();
    let calls = 0;
    const transport: CustomerAgentTransport = {
      async post() {
        calls += 1;
        return {
          status: 403,
          body: { ok: false, code: "AUTHORIZATION_DENIED" },
        };
      },
    };
    const agent = new CustomerAgent(transport, fixture.identity);

    await expect(agent.activateSelfManaged("AUTO")).resolves.toMatchObject({
      ok: false,
      code: "GATEWAY_REJECTED",
      status: 403,
    });
    expect(calls).toBe(1);
  });
});
