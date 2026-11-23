/**
 * Master-XAUUSD V6: exact CORS Origin selection, NOT authentication or LIVE access.
 *
 * A browser Origin is a scheme + authority (no path, userinfo or query). Never
 * reflect an arbitrary localhost port or any *.trycloudflare.com host. Clients
 * without an Origin header do not need CORS response headers.
 *
 * Explicit remote origins require HTTPS and exact V6_ALLOWED_ORIGINS matching.
 * Serving Web and API from the same origin does not require any CORS exception.
 */
function canonicalOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (value === "null" || value === "*" || /[\s,\\]/.test(value)) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
    return u.origin === value ? value : null;
  } catch {
    return null;
  }
}

function usablePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export function resolveAllowedOriginValue(
  suppliedOrigin,
  { webPort = 5717, apiPort = 3711, configuredOrigins = "" } = {},
) {
  const origin = canonicalOrigin(suppliedOrigin);
  if (!origin) return null;

  const allowed = new Set();
  for (const port of [usablePort(webPort), usablePort(apiPort)]) {
    if (port === null) continue;
    allowed.add(`http://127.0.0.1:${port}`);
    allowed.add(`http://localhost:${port}`);
  }

  // Additional origins are supplied by the host owner, not inferred from
  // proxy/Tunnel/LAN headers. HTTPS required for nonloopback origins.
  if (typeof configuredOrigins === "string") {
    for (const raw of configuredOrigins.split(",")) {
      const value = raw.trim();
      if (!value || !canonicalOrigin(value)) continue;
      const u = new URL(value);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "https:" || loopback) allowed.add(value);
    }
  }
  return allowed.has(origin) ? origin : null;
}
