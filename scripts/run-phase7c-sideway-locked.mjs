import { acquireExecutionLock } from "./phase7c-execution-lock.mjs";
import { resolveSidewayPermission } from "./phase7c-sideway-logic.mjs";
import {
  evaluatePhase7CAccountHealth,
  installPhase7CAccountOrderFetchGuard,
} from "./phase7c-account-runtime-guard.mjs";

const accountRuntime = installPhase7CAccountOrderFetchGuard({ label: "SIDEWAY" });
const nativeFetch = globalThis.fetch.bind(globalThis);
const controlApiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const symbol = (process.env.ZIQ_PHASE7C_SIDEWAY_SYMBOL || process.env.ZIQ_DEMO_SYMBOL || "XAUUSD").trim().toUpperCase();

console.log("PHASE7C_SIDEWAY_EXECUTION_LOCK=ENABLED");
console.log(`PHASE7C_SIDEWAY_LOCK_ACCOUNT_MODE=${accountRuntime.accountMode}`);
console.log("PHASE7C_SIDEWAY_ACCOUNT_AND_CANONICAL_GATE=UNDER_EXECUTION_LOCK");

globalThis.fetch = async function phase7CSidewayLockedFetch(input, init = undefined) {
  const request = toRequestInfo(input, init);
  if (!isNewOrderRequest(request)) return nativeFetch(input, init);

  const lock = acquireExecutionLock({ owner: "SIDEWAY" });
  if (!lock.acquired) {
    console.warn(`PHASE7C_SIDEWAY_ENTRY_BLOCKED=EXECUTION_LOCK_BUSY|DETAIL=${lock.reason}`);
    return blockedResponse("EXECUTION_LOCK_BUSY", lock.reason);
  }

  try {
    const [modePayload, health] = await Promise.all([
      controlRequest("/api/v1/phase7c/bot-mode"),
      fetchHealthUnderLock(request),
    ]);

    const accountGuard = evaluatePhase7CAccountHealth(health, accountRuntime, { armed: true });
    if (!accountGuard.allowed) {
      const detail = `${accountGuard.reason}${accountGuard.detail ? `;${accountGuard.detail}` : ""}`;
      console.warn(`PHASE7C_SIDEWAY_ENTRY_BLOCKED=ACCOUNT_GUARD|DETAIL=${detail}`);
      return blockedResponse("ACCOUNT_GUARD", detail);
    }

    const permission = resolveSidewayPermission(modePayload?.state?.mode, "SIDEWAY");
    if (!permission.allowed) {
      console.warn(`PHASE7C_SIDEWAY_ENTRY_BLOCKED=${permission.reason}`);
      return blockedResponse(permission.reason, `activeMode=${modePayload?.state?.mode ?? "UNKNOWN"}`);
    }

    const positions = await fetchOpenPositionsUnderLock(request);
    if (positions.length > 0) {
      console.warn(`PHASE7C_SIDEWAY_ENTRY_BLOCKED=POSITION_PRESENT_UNDER_LOCK|COUNT=${positions.length}`);
      return blockedResponse("POSITION_PRESENT_UNDER_LOCK", `Open ${symbol} positions=${positions.length}`);
    }

    const finalModePayload = await controlRequest("/api/v1/phase7c/bot-mode");
    const finalPermission = resolveSidewayPermission(finalModePayload?.state?.mode, "SIDEWAY");
    if (!finalPermission.allowed) {
      const finalMode = String(finalModePayload?.state?.mode ?? "PAUSE").toUpperCase();
      console.warn(
        `PHASE7C_SIDEWAY_ENTRY_BLOCKED=BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT|FINAL_${finalMode}|DETAIL=${finalPermission.reason}`,
      );
      return blockedResponse(
        "BOT_MODE_CHANGED_BEFORE_BROKER_SUBMIT",
        `activeMode=${finalMode};reason=${finalPermission.reason}`,
      );
    }

    // `nativeFetch` is the account-order guard installed before this lock wrapper.
    // It performs the canonical Daily Recovery recheck and only then reaches the
    // raw broker transport, so the canonical final gate executes while this
    // execution lock is still held.
    return await nativeFetch(input, init);
  } catch (error) {
    const message = errorMessage(error);
    console.error(`PHASE7C_SIDEWAY_ENTRY_BLOCKED=FINAL_LOCK_RECHECK_ERROR|DETAIL=${message}`);
    return blockedResponse("FINAL_LOCK_RECHECK_ERROR_FAIL_CLOSED", message);
  } finally {
    lock.release();
  }
};

await import("./run-phase7c-sideway-account-mode.mjs");

async function fetchHealthUnderLock(request) {
  const requestUrl = new URL(request.url);
  const response = await nativeFetch(`${requestUrl.origin}/health`, {
    method: "GET",
    headers: request.headers,
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MT5 bridge health recheck ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function fetchOpenPositionsUnderLock(request) {
  const requestUrl = new URL(request.url);
  const response = await nativeFetch(
    `${requestUrl.origin}/v1/positions?symbol=${encodeURIComponent(symbol)}`,
    { method: "GET", headers: request.headers },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`MT5 bridge position recheck ${response.status}: ${text}`);
  const parsed = text ? JSON.parse(text) : [];
  if (!Array.isArray(parsed)) throw new Error("MT5 bridge position recheck did not return an array.");
  return parsed;
}

async function controlRequest(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await nativeFetch(`${controlApiBase}${pathname}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Phase7C control API ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function isNewOrderRequest(request) {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url).pathname === "/v1/orders";
  } catch {
    return false;
  }
}

function toRequestInfo(input, init) {
  const isRequest = input instanceof Request;
  const requestMethod = isRequest ? input.method : undefined;
  const rawUrl = isRequest ? input.url : input instanceof URL ? input.href : String(input);
  return {
    method: String(init?.method ?? requestMethod ?? "GET").toUpperCase(),
    url: rawUrl,
    headers: new Headers(init?.headers ?? (isRequest ? input.headers : undefined)),
  };
}

function blockedResponse(reason, detail) {
  return new Response(
    JSON.stringify({
      error: "PHASE7C_SIDEWAY_ENTRY_BLOCKED",
      accepted: false,
      status: "blocked_by_phase7c_execution_gate",
      message: reason,
      detail,
    }),
    { status: 423, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
