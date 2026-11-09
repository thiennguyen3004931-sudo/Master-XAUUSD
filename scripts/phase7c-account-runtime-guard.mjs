import { verifyPhase7CCanonicalDailyRecoverySubmission } from "./phase7c-canonical-daily-recovery-executor.mjs";

const ACCOUNT_MODES = new Set(["DEMO", "LIVE"]);

export function truthyPhase7C(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

export function resolvePhase7CAccountRuntime(env = process.env) {
  const accountMode = String(env.ZIQ_PHASE7C_ACCOUNT_MODE || "DEMO").trim().toUpperCase();
  if (!ACCOUNT_MODES.has(accountMode)) {
    throw new Error(`Invalid ZIQ_PHASE7C_ACCOUNT_MODE=${accountMode || "missing"}. Expected DEMO or LIVE.`);
  }

  const liveExecutionEnabled = truthyPhase7C(env.ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED);
  const allowRealAccount = truthyPhase7C(env.MT5_ALLOW_REAL_ACCOUNT);
  const tradingConfigured = truthyPhase7C(env.MT5_TRADING_ENABLED);
  const allowedLogins = new Set(
    String(env.MT5_ALLOWED_LOGINS || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  if (accountMode === "DEMO") {
    if (liveExecutionEnabled) {
      throw new Error("DEMO runtime cannot set ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED=true.");
    }
    if (allowRealAccount) {
      throw new Error("DEMO runtime requires MT5_ALLOW_REAL_ACCOUNT=false.");
    }
  } else {
    if (!liveExecutionEnabled) {
      throw new Error("LIVE runtime requires ZIQ_PHASE7C_LIVE_EXECUTION_ENABLED=true.");
    }
    if (!allowRealAccount) {
      throw new Error("LIVE runtime requires MT5_ALLOW_REAL_ACCOUNT=true.");
    }
  }

  return Object.freeze({
    accountMode,
    expectedBrokerMode: accountMode === "LIVE" ? "real" : "demo",
    liveExecutionEnabled,
    allowRealAccount,
    tradingConfigured,
    allowedLogins,
  });
}

export function evaluatePhase7CAccountHealth(health, runtime, { armed = true } = {}) {
  if (!health || typeof health !== "object") {
    return { allowed: false, reason: "HEALTH_UNAVAILABLE" };
  }
  if (!health.connected || health.status !== "ok") {
    return { allowed: false, reason: "BRIDGE_NOT_HEALTHY" };
  }
  if (String(health.accountMode ?? "").toLowerCase() !== runtime.expectedBrokerMode) {
    return {
      allowed: false,
      reason: "ACCOUNT_MODE_MISMATCH",
      detail: `configured=${runtime.accountMode};broker=${health.accountMode ?? "unknown"}`,
    };
  }

  const login = Number(health.accountLogin);
  if (!Number.isFinite(login) || login <= 0) {
    return { allowed: false, reason: "ACCOUNT_LOGIN_UNAVAILABLE" };
  }

  if (armed) {
    if (!runtime.tradingConfigured) {
      return { allowed: false, reason: "TRADING_NOT_CONFIGURED" };
    }
    if (!health.tradingEnabled) {
      return { allowed: false, reason: "BRIDGE_TRADING_DISABLED" };
    }
    if (!health.terminalTradeAllowed || !health.expertTradeAllowed) {
      return { allowed: false, reason: "MT5_AUTOMATED_TRADING_DISABLED" };
    }
    if (runtime.allowedLogins.size === 0) {
      return { allowed: false, reason: "ACCOUNT_ALLOWLIST_EMPTY" };
    }
    if (!runtime.allowedLogins.has(login)) {
      return { allowed: false, reason: "ACCOUNT_LOGIN_NOT_ALLOWLISTED" };
    }
  }

  return { allowed: true, reason: "PASS", login };
}

export function assertPhase7CAccountHealth(health, runtime, options = {}) {
  const result = evaluatePhase7CAccountHealth(health, runtime, options);
  if (!result.allowed) {
    throw new Error(
      `Phase7C ${runtime.accountMode} account guard blocked runtime: ${result.reason}${result.detail ? ` (${result.detail})` : ""}.`,
    );
  }
  return result;
}

function requestInfo(input, init) {
  const isRequest = typeof Request !== "undefined" && input instanceof Request;
  const requestMethod = isRequest ? input.method : undefined;
  const rawUrl = isRequest
    ? input.url
    : input instanceof URL
      ? input.href
      : String(input);
  return {
    method: String(init?.method ?? requestMethod ?? "GET").toUpperCase(),
    url: rawUrl,
    headers: new Headers(init?.headers ?? (isRequest ? input.headers : undefined)),
    body: typeof init?.body === "string" ? init.body : null,
  };
}

function blockedAccountResponse(runtime, result) {
  return new Response(
    JSON.stringify({
      error: "PHASE7C_ACCOUNT_GUARD_BLOCKED",
      accepted: false,
      status: "blocked_by_phase7c_account_gate",
      accountMode: runtime.accountMode,
      expectedBrokerMode: runtime.expectedBrokerMode,
      reason: result.reason,
      detail: result.detail ?? null,
    }),
    { status: 423, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export function installPhase7CAccountOrderFetchGuard({
  label = "EXECUTOR",
  env = process.env,
} = {}) {
  const runtime = resolvePhase7CAccountRuntime(env);
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function phase7CAccountGuardedFetch(input, init = undefined) {
    const request = requestInfo(input, init);
    if (request.method !== "POST") return nativeFetch(input, init);

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return nativeFetch(input, init);
    }
    if (url.pathname !== "/v1/orders") return nativeFetch(input, init);

    try {
      const healthResponse = await nativeFetch(`${url.origin}/health`, {
        method: "GET",
        headers: request.headers,
        cache: "no-store",
      });
      const text = await healthResponse.text();
      if (!healthResponse.ok) {
        const result = {
          allowed: false,
          reason: "HEALTH_RECHECK_FAILED",
          detail: `HTTP=${healthResponse.status};${text.slice(0, 200)}`,
        };
        console.error(`PHASE7C_${label}_ACCOUNT_ENTRY_BLOCKED=${result.reason}`);
        return blockedAccountResponse(runtime, result);
      }
      let health;
      try {
        health = text ? JSON.parse(text) : null;
      } catch {
        const result = { allowed: false, reason: "HEALTH_RECHECK_INVALID_JSON" };
        console.error(`PHASE7C_${label}_ACCOUNT_ENTRY_BLOCKED=${result.reason}`);
        return blockedAccountResponse(runtime, result);
      }
      const result = evaluatePhase7CAccountHealth(health, runtime, { armed: true });
      if (!result.allowed) {
        console.warn(`PHASE7C_${label}_ACCOUNT_ENTRY_BLOCKED=${result.reason}|MODE=${runtime.accountMode}`);
        return blockedAccountResponse(runtime, result);
      }

      try {
        const canonical = await verifyPhase7CCanonicalDailyRecoverySubmission({
          strategy: label,
          requestBody: request.body,
          fetchImpl: nativeFetch,
          env,
        });
        console.log(
          `PHASE7C_${label}_CANONICAL_DAILY_RECOVERY_FINAL_GATE=PASS|DAILY_MODE=${canonical.canonicalDailyMode}|DAILY_NET_PNL=${canonical.dailyNetPnl}`,
        );
      } catch (error) {
        const canonicalResult = {
          allowed: false,
          reason: "CANONICAL_DAILY_RECOVERY_FINAL_GATE_FAIL_CLOSED",
          detail: error instanceof Error ? error.message : String(error),
        };
        console.error(
          `PHASE7C_${label}_ACCOUNT_ENTRY_BLOCKED=${canonicalResult.reason}|DETAIL=${canonicalResult.detail}`,
        );
        return blockedAccountResponse(runtime, canonicalResult);
      }

      console.log(`PHASE7C_${label}_ACCOUNT_ENTRY_GATE=PASS|MODE=${runtime.accountMode}`);
      return nativeFetch(input, init);
    } catch (error) {
      const result = {
        allowed: false,
        reason: "ACCOUNT_RECHECK_ERROR_FAIL_CLOSED",
        detail: error instanceof Error ? error.message : String(error),
      };
      console.error(`PHASE7C_${label}_ACCOUNT_ENTRY_BLOCKED=${result.reason}`);
      return blockedAccountResponse(runtime, result);
    }
  };

  return runtime;
}
