"use strict";

function canonicalError(status, message) {
  const error = new Error(message || `CANONICAL_HTTP_${status}`);
  error.status = status;
  return error;
}

async function parseJson(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw canonicalError(response.status, `CANONICAL_INVALID_JSON_${response.status}`);
  }
  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : typeof payload.message === "string"
        ? payload.message
        : `CANONICAL_HTTP_${response.status}`;
    throw canonicalError(response.status, message.slice(0, 500));
  }
  return payload;
}

function createCanonicalClient({ apiOrigin, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (apiOrigin !== "http://127.0.0.1:3711") {
    throw new Error("CANONICAL_API_ORIGIN_MUST_BE_LOOPBACK_3711");
  }

  async function request(path, init) {
    const response = await fetchImpl(`${apiOrigin}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return parseJson(response);
  }

  return Object.freeze({
    getBotMode() {
      return request("/api/v1/phase7c/bot-mode", { method: "GET" });
    },

    getAutoStatus() {
      return request("/api/v1/phase7c-auto-activation/status", { method: "GET" });
    },

    executeModeAction(action) {
      if (action === "MODE_AUTO") {
        return request("/api/v1/phase7c-auto-activation/enable", {
          method: "POST",
          body: "{}",
        });
      }

      const modeByAction = {
        MODE_SEMI: "SEMI",
        MODE_TREND: "TREND",
        MODE_SIDEWAY: "SIDEWAY",
        MODE_PAUSE: "PAUSE",
      };
      const mode = modeByAction[action];
      if (!mode) throw new Error("UNSUPPORTED_MODE_ACTION");
      return request("/api/v1/phase7c/bot-mode", {
        method: "POST",
        body: JSON.stringify({ mode, source: "mobile-control-center" }),
      });
    },

    getArmCapability() {
      return request("/api/v1/phase7c-live-arm-control/capability", { method: "GET" });
    },

    createArmPreflight(action) {
      if (action !== "ARM_LIVE" && action !== "DISARM_LIVE") throw new Error("UNSUPPORTED_ARM_ACTION");
      return request("/api/v1/phase7c-live-arm-control/preflight", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
    },

    executeArm(action, preflightToken) {
      if (action !== "ARM_LIVE" && action !== "DISARM_LIVE") throw new Error("UNSUPPORTED_ARM_ACTION");
      if (!preflightToken) throw new Error("PREFLIGHT_TOKEN_REQUIRED");
      return request("/api/v1/phase7c-live-arm-control/execute", {
        method: "POST",
        body: JSON.stringify({ action, preflightToken, confirmation: action }),
      });
    },

    getArmStatus(requestId) {
      const id = String(requestId ?? "").trim();
      if (!id) throw new Error("REQUEST_ID_REQUIRED");
      return request(`/api/v1/phase7c-live-arm-control/status?requestId=${encodeURIComponent(id)}`, { method: "GET" });
    },
  });
}

module.exports = { createCanonicalClient };
