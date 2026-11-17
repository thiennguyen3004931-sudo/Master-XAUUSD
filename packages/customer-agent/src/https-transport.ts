import { request as httpsRequest } from "node:https";
import {
  CUSTOMER_AGENT_MAX_BODY_BYTES,
  type CustomerAgentTransport,
  type CustomerAgentTransportResponse,
} from "./agent.js";

export const CUSTOMER_AGENT_DEFAULT_TIMEOUT_MS = 8_000;

function canonicalBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("baseUrl must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("baseUrl must be credential-free HTTPS");
  }
  return url;
}

function boundedJson(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > CUSTOMER_AGENT_MAX_BODY_BYTES) {
    throw new RangeError("REQUEST_BODY_TOO_LARGE");
  }
  return payload;
}

export class HttpsCustomerAgentTransport implements CustomerAgentTransport {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly timeoutMs = CUSTOMER_AGENT_DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = canonicalBaseUrl(baseUrl);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 60_000
    ) {
      throw new TypeError("timeoutMs must be a safe integer from 1 to 60000");
    }
  }

  post(
    path: string,
    bearerToken: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<CustomerAgentTransportResponse> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      return Promise.reject(new TypeError("path must be an absolute API path"));
    }

    const target = new URL(path, this.baseUrl);
    if (target.origin !== this.baseUrl.origin) {
      return Promise.reject(new TypeError("cross-origin request is forbidden"));
    }

    const payload = boundedJson(body);

    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        target,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
            "content-type": "application/json",
            "content-length": String(payload.byteLength),
            accept: "application/json",
          },
          timeout: this.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let total = 0;

          response.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk, "utf8");
            total += buffer.byteLength;
            if (total > CUSTOMER_AGENT_MAX_BODY_BYTES) {
              response.destroy(new RangeError("RESPONSE_BODY_TOO_LARGE"));
              return;
            }
            chunks.push(buffer);
          });

          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = text.length === 0 ? null : JSON.parse(text);
            } catch {
              parsed = null;
            }
            resolve({
              status: response.statusCode ?? 503,
              body: parsed,
            });
          });

          response.on("error", reject);
        },
      );

      request.on("timeout", () => {
        request.destroy(new Error("CUSTOMER_AGENT_TIMEOUT"));
      });
      request.on("error", reject);
      request.end(payload);
    });
  }
}
