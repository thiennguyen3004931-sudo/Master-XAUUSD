import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type ServerOptions as HttpsServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CustomerGrantRegistryRepository } from "@xauusd/customer-grant-registry";
import type { CustomerLicenseResolver } from "@xauusd/customer-runtime-gate";
import {
  activateCopyFollowerSession,
  activateSelfManagedSession,
  issueCopyFollowerReconnectChallenge,
  issueSelfManagedReconnectChallenge,
  type CustomerRuntimeChallengeStore,
  type CustomerRuntimeSessionClock,
} from "./session.js";

export const CUSTOMER_API_MAX_BODY_BYTES = 32 * 1024;
export const CUSTOMER_API_DEFAULT_RATE_WINDOW_MS = 60_000;
export const CUSTOMER_API_DEFAULT_RATE_LIMIT = 60;

export interface CustomerApiPrincipal {
  readonly customerId: string;
}

export interface CustomerApiAuthenticator {
  authenticate(bearerToken: string): Promise<CustomerApiPrincipal | null>;
}

export interface CustomerApiRateLimiter {
  allow(key: string, now: number): Promise<boolean>;
}

export interface CustomerApiRestoreAdmissionRequest {
  readonly customerId: string;
  readonly grantId: string;
  readonly installationId: string;
  readonly productMode: "SELF_MANAGED" | "COPY_FOLLOWER";
  readonly operation: "CHALLENGE" | "ACTIVATE";
  readonly now: number;
}

export type CustomerApiRestoreAdmissionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reasonCode?: string };

export interface CustomerApiRestoreAdmissionGate {
  admit(
    request: CustomerApiRestoreAdmissionRequest,
  ): Promise<CustomerApiRestoreAdmissionDecision>;
}

export interface CustomerApiGatewayRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly contentType?: string;
  readonly remoteAddress?: string;
  readonly body?: string | Uint8Array | null;
}

export interface CustomerApiGatewayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CustomerApiGatewayDependencies {
  readonly grants: CustomerGrantRegistryRepository;
  readonly licenses: CustomerLicenseResolver;
  readonly challenges: CustomerRuntimeChallengeStore;
  readonly clock: CustomerRuntimeSessionClock;
  readonly authenticator: CustomerApiAuthenticator;
  readonly rateLimiter: CustomerApiRateLimiter;
  readonly restoreAdmissionGate?: CustomerApiRestoreAdmissionGate;
}

type HashedTokenRecord = {
  readonly customerId: string;
  readonly tokenSha256Hex: string;
};

function canonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim().length > 0 &&
    value.trim() === value
  );
}

function safeNow(clock: CustomerRuntimeSessionClock): number | null {
  try {
    const now = clock.now();
    return Number.isSafeInteger(now) ? now : null;
  } catch {
    return null;
  }
}

export function sha256CustomerApiToken(token: string): string {
  if (!canonicalString(token) || token.length > 4096) {
    throw new TypeError("token must be a canonical non-blank string");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class Sha256CustomerApiKeyAuthenticator
  implements CustomerApiAuthenticator
{
  private readonly records: readonly {
    readonly customerId: string;
    readonly digest: Buffer;
  }[];

  constructor(records: readonly HashedTokenRecord[]) {
    const seen = new Set<string>();
    this.records = Object.freeze(
      records.map((record) => {
        if (!canonicalString(record.customerId)) {
          throw new TypeError("customerId must be canonical");
        }
        if (!/^[0-9a-f]{64}$/.test(record.tokenSha256Hex)) {
          throw new TypeError("tokenSha256Hex must be lowercase SHA-256 hex");
        }
        if (seen.has(record.tokenSha256Hex)) {
          throw new TypeError("duplicate customer API token hash");
        }
        seen.add(record.tokenSha256Hex);
        return Object.freeze({
          customerId: record.customerId,
          digest: Buffer.from(record.tokenSha256Hex, "hex"),
        });
      }),
    );
  }

  async authenticate(bearerToken: string): Promise<CustomerApiPrincipal | null> {
    let candidate: Buffer;
    try {
      candidate = Buffer.from(sha256CustomerApiToken(bearerToken), "hex");
    } catch {
      return null;
    }

    let matched: string | null = null;
    for (const record of this.records) {
      if (
        record.digest.length === candidate.length &&
        timingSafeEqual(record.digest, candidate)
      ) {
        matched = record.customerId;
      }
    }

    return matched ? Object.freeze({ customerId: matched }) : null;
  }
}

export class InMemoryFixedWindowCustomerApiRateLimiter
  implements CustomerApiRateLimiter
{
  private readonly buckets = new Map<
    string,
    { windowStart: number; count: number }
  >();

  constructor(
    private readonly maxRequests = CUSTOMER_API_DEFAULT_RATE_LIMIT,
    private readonly windowMs = CUSTOMER_API_DEFAULT_RATE_WINDOW_MS,
  ) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
      throw new TypeError("maxRequests must be a positive safe integer");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new TypeError("windowMs must be a positive safe integer");
    }
  }

  async allow(key: string, now: number): Promise<boolean> {
    if (!canonicalString(key) || !Number.isSafeInteger(now)) return false;

    const current = this.buckets.get(key);
    if (!current || now < current.windowStart || now - current.windowStart >= this.windowMs) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }

    if (current.count >= this.maxRequests) return false;
    current.count += 1;
    return true;
  }
}

function json(status: number, payload: unknown): CustomerApiGatewayResponse {
  return Object.freeze({
    status,
    headers: Object.freeze({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
    body: JSON.stringify(payload),
  });
}

function bodyText(body: string | Uint8Array | null | undefined): string | null {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8") <= CUSTOMER_API_MAX_BODY_BYTES
      ? body
      : null;
  }
  return body.byteLength <= CUSTOMER_API_MAX_BODY_BYTES
    ? Buffer.from(body).toString("utf8")
    : null;
}

function parseExactObject(
  raw: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return null;
  }
  return record;
}

function bearerToken(authorization: string | undefined): string | null {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return canonicalString(token) && token.length <= 4096 ? token : null;
}

async function authorizeGrant(
  dependencies: CustomerApiGatewayDependencies,
  principal: CustomerApiPrincipal,
  grantId: unknown,
  installationId: unknown,
  productMode: unknown,
): Promise<"OK" | "DENIED" | "SOURCE_ERROR"> {
  if (
    !canonicalString(grantId) ||
    !canonicalString(installationId) ||
    (productMode !== "SELF_MANAGED" && productMode !== "COPY_FOLLOWER")
  ) {
    return "DENIED";
  }

  try {
    const lifecycle = await dependencies.grants.get(grantId);
    if (
      !lifecycle ||
      lifecycle.grant.customerId !== principal.customerId ||
      lifecycle.grant.installationId !== installationId ||
      lifecycle.grant.productMode !== productMode
    ) {
      return "DENIED";
    }
    return "OK";
  } catch {
    return "SOURCE_ERROR";
  }
}

async function evaluateRestoreAdmission(
  dependencies: CustomerApiGatewayDependencies,
  request: CustomerApiRestoreAdmissionRequest,
): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly code: string }> {
  if (!dependencies.restoreAdmissionGate) {
    return { allowed: true };
  }
  try {
    const decision = await dependencies.restoreAdmissionGate.admit(request);
    if (decision && decision.allowed === true) {
      return { allowed: true };
    }
    const code =
      decision &&
      decision.allowed === false &&
      canonicalString(decision.reasonCode)
        ? decision.reasonCode
        : "RESTORE_ADMISSION_QUARANTINED";
    return { allowed: false, code };
  } catch {
    return { allowed: false, code: "RESTORE_ADMISSION_QUARANTINED" };
  }
}

function downstreamStatus(decision: unknown): number {
  if (
    decision === null ||
    typeof decision !== "object" ||
    Array.isArray(decision)
  ) {
    return 503;
  }
  const value = decision as Record<string, unknown>;
  if (value.ok === true) return 200;
  const code = value.code;
  if (
    code === "INVALID_CHALLENGE_REQUEST" ||
    code === "INVALID_SESSION_CONTEXT" ||
    code === "INVALID_RUNTIME_REQUEST"
  ) {
    return 400;
  }
  if (
    code === "INVALID_GRANT_SOURCE" ||
    code === "INVALID_LICENSE_SOURCE" ||
    code === "INVALID_RUNTIME_SECURITY_CONTEXT" ||
    code === "CHALLENGE_STORE_REJECTED" ||
    code === "RUNTIME_STATE_CHANGED"
  ) {
    return 503;
  }
  return 403;
}

export class CustomerApiGateway {
  constructor(private readonly dependencies: CustomerApiGatewayDependencies) {}

  async handle(
    request: CustomerApiGatewayRequest,
  ): Promise<CustomerApiGatewayResponse> {
    if (
      request.path !== "/v1/customer/runtime/challenge" &&
      request.path !== "/v1/customer/runtime/activate"
    ) {
      return json(404, { ok: false, code: "NOT_FOUND" });
    }

    if (request.method !== "POST") {
      return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    }

    if (
      typeof request.contentType !== "string" ||
      !request.contentType.toLowerCase().startsWith("application/json")
    ) {
      return json(415, { ok: false, code: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const rawBody = bodyText(request.body);
    if (rawBody === null) {
      return json(413, { ok: false, code: "BODY_TOO_LARGE" });
    }

    const now = safeNow(this.dependencies.clock);
    if (now === null) {
      return json(503, { ok: false, code: "INVALID_SERVER_CLOCK" });
    }

    const remoteAddress = canonicalString(request.remoteAddress)
      ? request.remoteAddress
      : "unknown";
    let rateAllowed = false;
    try {
      rateAllowed = await this.dependencies.rateLimiter.allow(
        `ip:${remoteAddress}`,
        now,
      );
    } catch {
      rateAllowed = false;
    }
    if (!rateAllowed) {
      return json(429, { ok: false, code: "RATE_LIMITED" });
    }

    const token = bearerToken(request.authorization);
    if (!token) {
      return json(401, { ok: false, code: "UNAUTHORIZED" });
    }

    let principal: CustomerApiPrincipal | null = null;
    try {
      principal = await this.dependencies.authenticator.authenticate(token);
    } catch {
      return json(503, { ok: false, code: "AUTH_SOURCE_UNAVAILABLE" });
    }
    if (!principal || !canonicalString(principal.customerId)) {
      return json(401, { ok: false, code: "UNAUTHORIZED" });
    }

    try {
      rateAllowed = await this.dependencies.rateLimiter.allow(
        `customer:${principal.customerId}`,
        now,
      );
    } catch {
      rateAllowed = false;
    }
    if (!rateAllowed) {
      return json(429, { ok: false, code: "RATE_LIMITED" });
    }

    if (request.path === "/v1/customer/runtime/challenge") {
      const body = parseExactObject(rawBody, [
        "productMode",
        "grantId",
        "installationId",
      ]);
      if (!body) {
        return json(400, { ok: false, code: "INVALID_REQUEST" });
      }

      const authorization = await authorizeGrant(
        this.dependencies,
        principal,
        body.grantId,
        body.installationId,
        body.productMode,
      );
      if (authorization === "SOURCE_ERROR") {
        return json(503, { ok: false, code: "GRANT_SOURCE_UNAVAILABLE" });
      }
      if (authorization !== "OK") {
        return json(403, { ok: false, code: "AUTHORIZATION_DENIED" });
      }

      const restoreAdmission = await evaluateRestoreAdmission(
        this.dependencies,
        {
          customerId: principal.customerId,
          grantId: body.grantId as string,
          installationId: body.installationId as string,
          productMode: body.productMode as "SELF_MANAGED" | "COPY_FOLLOWER",
          operation: "CHALLENGE",
          now,
        },
      );
      if (!restoreAdmission.allowed) {
        return json(503, { ok: false, code: restoreAdmission.code });
      }

      const challengeRequest = {
        grantId: body.grantId,
        installationId: body.installationId,
      };

      const decision =
        body.productMode === "SELF_MANAGED"
          ? await issueSelfManagedReconnectChallenge(
              this.dependencies.grants,
              this.dependencies.licenses,
              this.dependencies.challenges,
              this.dependencies.clock,
              challengeRequest,
            )
          : await issueCopyFollowerReconnectChallenge(
              this.dependencies.grants,
              this.dependencies.licenses,
              this.dependencies.challenges,
              this.dependencies.clock,
              challengeRequest,
            );

      return json(downstreamStatus(decision), decision);
    }

    const parsed: unknown = (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return null;
      }
    })();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { ok: false, code: "INVALID_REQUEST" });
    }

    const raw = parsed as Record<string, unknown>;
    const productMode = raw.productMode;
    const requiredKeys =
      productMode === "SELF_MANAGED"
        ? [
            "productMode",
            "grantId",
            "installationId",
            "mt5Login",
            "brokerServer",
            "requestedBotMode",
            "proof",
          ]
        : productMode === "COPY_FOLLOWER"
          ? [
              "productMode",
              "grantId",
              "installationId",
              "mt5Login",
              "brokerServer",
              "requestedSizingMode",
              "proof",
            ]
          : null;

    if (!requiredKeys) {
      return json(400, { ok: false, code: "INVALID_REQUEST" });
    }

    const body = parseExactObject(rawBody, requiredKeys);
    if (!body) {
      return json(400, { ok: false, code: "INVALID_REQUEST" });
    }

    const authorization = await authorizeGrant(
      this.dependencies,
      principal,
      body.grantId,
      body.installationId,
      body.productMode,
    );
    if (authorization === "SOURCE_ERROR") {
      return json(503, { ok: false, code: "GRANT_SOURCE_UNAVAILABLE" });
    }
    if (authorization !== "OK") {
      return json(403, { ok: false, code: "AUTHORIZATION_DENIED" });
    }

    const restoreAdmission = await evaluateRestoreAdmission(
      this.dependencies,
      {
        customerId: principal.customerId,
        grantId: body.grantId as string,
        installationId: body.installationId as string,
        productMode: body.productMode as "SELF_MANAGED" | "COPY_FOLLOWER",
        operation: "ACTIVATE",
        now,
      },
    );
    if (!restoreAdmission.allowed) {
      return json(503, { ok: false, code: restoreAdmission.code });
    }

    const activation = { ...body };
    delete activation.productMode;

    const decision =
      body.productMode === "SELF_MANAGED"
        ? await activateSelfManagedSession(
            this.dependencies.grants,
            this.dependencies.licenses,
            this.dependencies.challenges,
            this.dependencies.clock,
            activation,
          )
        : await activateCopyFollowerSession(
            this.dependencies.grants,
            this.dependencies.licenses,
            this.dependencies.challenges,
            this.dependencies.clock,
            activation,
          );

    return json(downstreamStatus(decision), decision);
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const rawLength = request.headers["content-length"];
  if (typeof rawLength === "string") {
    const declared = Number(rawLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > CUSTOMER_API_MAX_BODY_BYTES
    ) {
      throw new RangeError("BODY_TOO_LARGE");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > CUSTOMER_API_MAX_BODY_BYTES) {
      throw new RangeError("BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function writeGatewayResponse(
  response: ServerResponse,
  gatewayResponse: CustomerApiGatewayResponse,
): void {
  response.writeHead(gatewayResponse.status, gatewayResponse.headers);
  response.end(gatewayResponse.body);
}

export function createCustomerApiGatewayHttpsServer(
  gateway: CustomerApiGateway,
  tlsOptions: HttpsServerOptions,
) {
  return createServer(tlsOptions, async (request, response) => {
    try {
      const body = await readBoundedBody(request);
      const authorizationHeader = request.headers.authorization;
      const authorization =
        typeof authorizationHeader === "string"
          ? authorizationHeader
          : undefined;
      const contentTypeHeader = request.headers["content-type"];
      const contentType =
        typeof contentTypeHeader === "string" ? contentTypeHeader : undefined;
      const url = new URL(request.url ?? "/", "https://localhost");

      const gatewayResponse = await gateway.handle({
        method: request.method ?? "",
        path: url.pathname,
        authorization,
        contentType,
        remoteAddress: request.socket.remoteAddress ?? "unknown",
        body,
      });
      writeGatewayResponse(response, gatewayResponse);
    } catch (error) {
      const tooLarge =
        error instanceof RangeError && error.message === "BODY_TOO_LARGE";
      writeGatewayResponse(
        response,
        json(
          tooLarge ? 413 : 503,
          tooLarge
            ? { ok: false, code: "BODY_TOO_LARGE" }
            : { ok: false, code: "GATEWAY_FAILURE" },
        ),
      );
    }
  });
}
