import type { KeyObject } from "node:crypto";
import {
  assertInstallationChallenge,
  signInstallationProof,
  type InstallationChallenge,
} from "@xauusd/installation-proof";

export const CUSTOMER_AGENT_MAX_BODY_BYTES = 32 * 1024;
export const CUSTOMER_AGENT_MAX_ATTEMPTS = 3;
export const CUSTOMER_AGENT_RETRY_DELAYS_MS = [250, 500] as const;

export type CustomerAgentProductMode = "SELF_MANAGED" | "COPY_FOLLOWER";
export type CustomerAgentSelfManagedBotMode =
  | "PAUSE"
  | "AUTO"
  | "SEMI"
  | "TREND"
  | "SIDEWAY";
export type CustomerAgentCopySizingMode =
  | "EQUITY_RATIO"
  | "LOT_MULTIPLIER"
  | "FIXED_LOT";

export interface CustomerAgentTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CustomerAgentTransport {
  post(
    path: string,
    bearerToken: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CustomerAgentTransportResponse>;
}

export interface CustomerAgentSleeper {
  sleep(ms: number): Promise<void>;
}

export interface CustomerAgentIdentity {
  readonly apiToken: string;
  readonly grantId: string;
  readonly installationId: string;
  readonly installationPublicKey: string;
  readonly installationPrivateKey: KeyObject;
  readonly mt5Login: number;
  readonly brokerServer: string;
}

export type CustomerAgentActivationResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly productMode: CustomerAgentProductMode;
      readonly decision: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly code:
        | "TRANSPORT_FAILED"
        | "GATEWAY_REJECTED"
        | "INVALID_GATEWAY_RESPONSE"
        | "CHALLENGE_BINDING_MISMATCH";
      readonly status?: number;
      readonly decision?: unknown;
    };

const defaultSleeper: CustomerAgentSleeper = {
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

function canonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIdentity(identity: CustomerAgentIdentity): void {
  for (const [field, value] of [
    ["apiToken", identity.apiToken],
    ["grantId", identity.grantId],
    ["installationId", identity.installationId],
    ["installationPublicKey", identity.installationPublicKey],
    ["brokerServer", identity.brokerServer],
  ] as const) {
    if (!canonicalString(value)) {
      throw new TypeError(`${field} must be a canonical non-blank string`);
    }
  }

  if (identity.apiToken.length > 4096) {
    throw new TypeError("apiToken exceeds maximum length");
  }
  if (!Number.isSafeInteger(identity.mt5Login) || identity.mt5Login <= 0) {
    throw new TypeError("mt5Login must be a positive safe integer");
  }
  if (
    identity.installationPrivateKey.type !== "private" ||
    identity.installationPrivateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new TypeError("installationPrivateKey must be Ed25519");
  }
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

export class CustomerAgent {
  constructor(
    private readonly transport: CustomerAgentTransport,
    private readonly identity: CustomerAgentIdentity,
    private readonly sleeper: CustomerAgentSleeper = defaultSleeper,
    private readonly maxAttempts = CUSTOMER_AGENT_MAX_ATTEMPTS,
  ) {
    assertIdentity(identity);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0 || maxAttempts > 5) {
      throw new TypeError("maxAttempts must be a safe integer from 1 to 5");
    }
  }

  private async post(
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CustomerAgentTransportResponse | null> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.transport.post(
          path,
          this.identity.apiToken,
          body,
        );

        if (
          retryableStatus(response.status) &&
          attempt < this.maxAttempts
        ) {
          await this.sleeper.sleep(
            CUSTOMER_AGENT_RETRY_DELAYS_MS[
              Math.min(attempt - 1, CUSTOMER_AGENT_RETRY_DELAYS_MS.length - 1)
            ],
          );
          continue;
        }

        return response;
      } catch {
        if (attempt >= this.maxAttempts) return null;
        await this.sleeper.sleep(
          CUSTOMER_AGENT_RETRY_DELAYS_MS[
            Math.min(attempt - 1, CUSTOMER_AGENT_RETRY_DELAYS_MS.length - 1)
          ],
        );
      }
    }
    return null;
  }

  private async challenge(
    productMode: CustomerAgentProductMode,
  ): Promise<InstallationChallenge | CustomerAgentActivationResult> {
    const response = await this.post("/v1/customer/runtime/challenge", {
      productMode,
      grantId: this.identity.grantId,
      installationId: this.identity.installationId,
    });

    if (!response) {
      return { ok: false, code: "TRANSPORT_FAILED" };
    }
    if (response.status !== 200) {
      return {
        ok: false,
        code: "GATEWAY_REJECTED",
        status: response.status,
        decision: response.body,
      };
    }
    if (!isRecord(response.body) || response.body.ok !== true) {
      return {
        ok: false,
        code: "INVALID_GATEWAY_RESPONSE",
        status: response.status,
        decision: response.body,
      };
    }

    const challenge = response.body.challenge;
    try {
      assertInstallationChallenge(challenge);
    } catch {
      return {
        ok: false,
        code: "INVALID_GATEWAY_RESPONSE",
        status: response.status,
        decision: response.body,
      };
    }

    if (
      challenge.purpose !== "RECONNECT" ||
      challenge.installationId !== this.identity.installationId
    ) {
      return {
        ok: false,
        code: "CHALLENGE_BINDING_MISMATCH",
        status: response.status,
        decision: response.body,
      };
    }

    return challenge;
  }

  private async activate(
    productMode: CustomerAgentProductMode,
    authorizationField:
      | { readonly requestedBotMode: CustomerAgentSelfManagedBotMode }
      | { readonly requestedSizingMode: CustomerAgentCopySizingMode },
  ): Promise<CustomerAgentActivationResult> {
    const challenge = await this.challenge(productMode);
    if ("ok" in challenge) return challenge;

    let proof;
    try {
      proof = signInstallationProof({
        challenge,
        installationPublicKey: this.identity.installationPublicKey,
        privateKey: this.identity.installationPrivateKey,
      });
    } catch {
      return { ok: false, code: "CHALLENGE_BINDING_MISMATCH" };
    }

    const response = await this.post("/v1/customer/runtime/activate", {
      productMode,
      grantId: this.identity.grantId,
      installationId: this.identity.installationId,
      mt5Login: this.identity.mt5Login,
      brokerServer: this.identity.brokerServer,
      ...authorizationField,
      proof,
    });

    if (!response) {
      return { ok: false, code: "TRANSPORT_FAILED" };
    }
    if (
      response.status !== 200 ||
      !isRecord(response.body) ||
      response.body.ok !== true
    ) {
      return {
        ok: false,
        code:
          isRecord(response.body) && response.body.ok === false
            ? "GATEWAY_REJECTED"
            : "INVALID_GATEWAY_RESPONSE",
        status: response.status,
        decision: response.body,
      };
    }

    return {
      ok: true,
      status: 200,
      productMode,
      decision: Object.freeze({ ...response.body }),
    };
  }

  activateSelfManaged(
    requestedBotMode: CustomerAgentSelfManagedBotMode,
  ): Promise<CustomerAgentActivationResult> {
    return this.activate("SELF_MANAGED", { requestedBotMode });
  }

  activateCopyFollower(
    requestedSizingMode: CustomerAgentCopySizingMode,
  ): Promise<CustomerAgentActivationResult> {
    return this.activate("COPY_FOLLOWER", { requestedSizingMode });
  }
}
