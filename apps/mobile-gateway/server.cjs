"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_M4_BODY_BYTES = 8 * 1024;

function normalizedIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getAllowedIdentity(req, config) {
  const actual = normalizedIdentity(req.headers["tailscale-user-login"]);
  const allowed = new Set((config.allowedUsers ?? []).map(normalizedIdentity).filter(Boolean));
  return actual && allowed.has(actual) ? actual : null;
}

function allowedIdentity(req, config) {
  return Boolean(getAllowedIdentity(req, config));
}

function writeJson(res, statusCode, payload, method = "GET") {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  if (method === "HEAD") return res.end();
  res.end(body);
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("tailscale-")) continue;
    if (lower === "host" || lower === "content-length") continue;
    if (value !== undefined) headers[name] = value;
  }
  headers["x-m4-mobile-readonly"] = "1";
  return headers;
}

async function proxyReadOnly(req, res, config, fetchImpl) {
  const target = new URL(req.url || "/", config.webOrigin);
  let upstream;
  try {
    upstream = await fetchImpl(target, {
      method: req.method,
      headers: upstreamHeaders(req),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    return writeJson(res, 502, {
      error: "WEB_UPSTREAM_UNAVAILABLE",
      message: error instanceof Error ? error.message : "Web upstream unavailable.",
    }, req.method);
  }

  res.statusCode = upstream.status;
  for (const [name, value] of upstream.headers.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
    res.setHeader(name, value);
  }

  if (req.method === "HEAD") return res.end();
  const body = Buffer.from(await upstream.arrayBuffer());
  res.setHeader("content-length", body.length);
  res.end(body);
}

async function readStrictJson(req) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("CONTENT_TYPE_MUST_BE_APPLICATION_JSON");
    error.status = 415;
    throw error;
  }

  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_M4_BODY_BYTES) {
    const error = new Error("REQUEST_BODY_TOO_LARGE");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_M4_BODY_BYTES) {
      const error = new Error("REQUEST_BODY_TOO_LARGE");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text || "{}");
  } catch {
    const error = new Error("MALFORMED_JSON");
    error.status = 400;
    throw error;
  }
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const message = String(error?.message ?? "");
  if (message.includes("IDENTITY_MISMATCH")) return 403;
  if (message.includes("NOT_FOUND")) return 404;
  if (message.includes("EXPIRED") || message.includes("ALREADY_CONSUMED") || message.includes("ACTION_MISMATCH")) return 409;
  if (message.includes("AUDIT")) return 503;
  return 400;
}

function createMobileGatewayServer({ config, broker = null, fetchImpl = fetch } = {}) {
  if (!config || typeof config !== "object") throw new Error("GATEWAY_CONFIG_REQUIRED");
  if (!config.webOrigin) throw new Error("WEB_ORIGIN_REQUIRED");

  return http.createServer(async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    const path = requestUrl.pathname;

    if (path === "/__m2/health") {
      if (method !== "GET" && method !== "HEAD") {
        return writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" }, method);
      }
      return writeJson(res, 200, {
        ok: true,
        service: "phase7c-mobile-gateway",
        mode: broker ? "M4" : "M2_READ_ONLY",
      }, method);
    }

    if (path === "/__m4/action") {
      if (method !== "POST") return writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" }, method);
      const identity = getAllowedIdentity(req, config);
      if (!identity) return writeJson(res, 403, { error: "TAILSCALE_IDENTITY_REQUIRED" }, method);
      if (String(req.headers.origin ?? "") !== String(config.allowedOrigin ?? "")) {
        return writeJson(res, 403, { error: "ORIGIN_NOT_ALLOWED" }, method);
      }
      if (!broker) return writeJson(res, 503, { error: "M4_NOT_ENABLED" }, method);
      try {
        const body = await readStrictJson(req);
        const result = await broker.handleAction(identity, body);
        const status = Number(result?.httpStatus);
        const responseStatus = Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : result?.outcome === "AMBIGUOUS" ? 502 : 200;
        return writeJson(res, responseStatus, result, method);
      } catch (error) {
        return writeJson(res, errorStatus(error), { error: String(error?.message ?? "M4_ACTION_FAILED") }, method);
      }
    }

    if (path === "/__m4/state") {
      if (method !== "GET") return writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" }, method);
      const identity = getAllowedIdentity(req, config);
      if (!identity) return writeJson(res, 403, { error: "TAILSCALE_IDENTITY_REQUIRED" }, method);
      if (!broker) return writeJson(res, 503, { error: "M4_NOT_ENABLED" }, method);
      try {
        return writeJson(res, 200, await broker.getState(identity), method);
      } catch (error) {
        return writeJson(res, 502, { error: String(error?.message ?? "M4_STATE_FAILED") }, method);
      }
    }

    if (path === "/__m4/status") {
      if (method !== "GET") return writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" }, method);
      const identity = getAllowedIdentity(req, config);
      if (!identity) return writeJson(res, 403, { error: "TAILSCALE_IDENTITY_REQUIRED" }, method);
      if (!broker) return writeJson(res, 503, { error: "M4_NOT_ENABLED" }, method);
      const transactionId = String(requestUrl.searchParams.get("transactionId") ?? "").trim();
      if (!transactionId) return writeJson(res, 400, { error: "TRANSACTION_ID_REQUIRED" }, method);
      try {
        return writeJson(res, 200, await broker.getTransactionStatus(identity, transactionId), method);
      } catch (error) {
        return writeJson(res, errorStatus(error), { error: String(error?.message ?? "M4_STATUS_FAILED") }, method);
      }
    }

    if (path.startsWith("/__m4/")) {
      return writeJson(res, 404, { error: "M4_ROUTE_NOT_FOUND" }, method);
    }

    if (method !== "GET" && method !== "HEAD") {
      return writeJson(res, 405, { error: "METHOD_NOT_ALLOWED" }, method);
    }

    if (!allowedIdentity(req, config)) {
      return writeJson(res, 403, { error: "TAILSCALE_IDENTITY_REQUIRED" }, method);
    }

    return proxyReadOnly(req, res, config, fetchImpl);
  });
}

module.exports = {
  MAX_M4_BODY_BYTES,
  createMobileGatewayServer,
  normalizedIdentity,
};
