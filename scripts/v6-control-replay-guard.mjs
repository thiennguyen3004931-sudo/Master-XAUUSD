/**
 * Fail-closed, per-process V6 control-request replay guard.
 *
 * Authentication/authorization are enforced by the caller before this guard.
 * This blocks exact nonce replay in one running process, NOT cross-process,
 * restart-persistent replay or separately re-signed duplicate business intent.
 * Order risk/STOP/CLEAR gates remain independently mandatory.
 */
export const V6_REPLAY_WINDOW_MS = 300_000;
export const V6_REPLAY_NONCE_LIMIT = 10_000;

export function createV6ReplayGuard({ now = () => Date.now() } = {}) {
  const seenNonces = new Map();

  return function verifyReplayGuard(req) {
    const method = String(req?.method || "").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { ok: true };

    const nonce = req?.headers?.["x-v6-nonce"];
    const timestamp = req?.headers?.["x-v6-timestamp"];
    if (typeof nonce !== "string" || typeof timestamp !== "string" || !nonce || !timestamp) {
      return {
        ok: false,
        status: 400,
        error: "REPLAY_HEADERS_REQUIRED",
        message: "Thao tác điều khiển phải có x-v6-nonce và x-v6-timestamp.",
      };
    }

    // Strict size/format: a random 128-bit nonce and an epoch-milliseconds
    // timestamp. Never accept truthy arrays, whitespace, malformed numbers
    // or unbounded strings as anti-replay evidence.
    if (!/^[a-fA-F0-9]{32}$/.test(nonce) || !/^[0-9]{13}$/.test(timestamp)) {
      return {
        ok: false,
        status: 400,
        error: "REPLAY_HEADERS_MALFORMED",
        message: "Nonce phải có 32 ký tự hex và timestamp phải là epoch milliseconds.",
      };
    }
    const ts = Number(timestamp);
    const current = now();
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(ts)
        || Math.abs(current - ts) > V6_REPLAY_WINDOW_MS) {
      return {
        ok: false,
        status: 401,
        error: "REQUEST_TIMESTAMP_EXPIRED",
        message: "Timestamp đã hết hạn hoặc lệch quá cửa sổ chống replay.",
      };
    }

    for (const [key, expiresAt] of seenNonces.entries()) {
      if (current > expiresAt) seenNonces.delete(key);
    }
    const key = nonce.toLowerCase();
    if (seenNonces.has(key)) {
      return { ok: false, status: 409, error: "REPLAY_DETECTED", message: "Nonce đã được sử dụng." };
    }
    if (seenNonces.size >= V6_REPLAY_NONCE_LIMIT) {
      return {
        ok: false,
        status: 503,
        error: "REPLAY_GUARD_CAPACITY_REACHED",
        message: "Tạm khóa thao tác điều khiển vì giới hạn bộ nhớ chống replay.",
      };
    }
    seenNonces.set(key, current + 2 * V6_REPLAY_WINDOW_MS);
    return { ok: true };
  };
}
