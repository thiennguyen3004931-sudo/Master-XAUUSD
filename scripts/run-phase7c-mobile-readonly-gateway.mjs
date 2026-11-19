import http from "node:http";
import process from "node:process";

const BIND_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 5791;
const DEFAULT_WEB_PORT = 5717;
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const MOBILE_PAGE_PATH = "/phase7c-mobile";
const STATIC_PREFIXES = ["/assets/"];
const STATIC_PATHS = new Set(["/favicon.svg", "/phase7c-vi-user.js"]);

const API_RULES = new Map([
  ["/api/v1/mt5/status", (query) => exactQuery(query, { symbol: "XAUUSD" })],
  ["/api/v1/phase7c/decision-monitor/mt5", (query) => exactQuery(query, { symbol: "XAUUSD" })],
  ["/api/v1/phase7c-ui", (query) => exactQuery(query, { symbol: "XAUUSD" })],
  ["/api/v1/phase7c/lifecycle", (query) => exactQuery(query, {})],
  ["/api/v1/phase7c/account-risk", (query) => exactQuery(query, { riskPercent: "1", maxLot: "0.3" })],
  ["/api/v1/phase7c/lot-settings", (query) => exactQuery(query, {})],
  ["/api/v1/phase7c-account-switch/same-mode-readiness", (query) => exactQuery(query, {})],
  ["/api/v1/phase7c-live-arm-control/capability", (query) => exactQuery(query, {})],
  ["/api/v1/phase7c/runtime-source-attestation", (query) => exactQuery(query, {})],
]);

function readIntArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535.`);
  }
  return value;
}

function exactQuery(searchParams, expected) {
  const expectedEntries = Object.entries(expected);
  const actualEntries = Array.from(searchParams.entries());
  if (actualEntries.length !== expectedEntries.length) return false;
  for (const [key, value] of expectedEntries) {
    const values = searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== value) return false;
  }
  return true;
}

function isAllowedPath(url) {
  if (url.pathname === MOBILE_PAGE_PATH) return true;
  if (STATIC_PATHS.has(url.pathname)) return exactQuery(url.searchParams, {});
  if (STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return exactQuery(url.searchParams, {});
  }
  const apiRule = API_RULES.get(url.pathname);
  return apiRule ? apiRule(url.searchParams) : false;
}

function sendText(response, statusCode, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(body);
}

function safeUpstreamHeaders(request) {
  const headers = {
    accept: request.headers.accept ?? "*/*",
    "user-agent": request.headers["user-agent"] ?? "phase7c-mobile-readonly-gateway",
  };
  if (request.headers["if-none-match"]) headers["if-none-match"] = request.headers["if-none-match"];
  if (request.headers["if-modified-since"]) headers["if-modified-since"] = request.headers["if-modified-since"];
  return headers;
}

function safeResponseHeaders(upstreamHeaders) {
  const allowed = [
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "last-modified",
    "content-encoding",
  ];
  const headers = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
  for (const name of allowed) {
    const value = upstreamHeaders[name];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

const gatewayPort = readIntArg("--port", DEFAULT_GATEWAY_PORT);
const webPort = readIntArg("--web-port", DEFAULT_WEB_PORT);
if (gatewayPort === webPort) throw new Error("Gateway port and Web port must be different.");

const server = http.createServer((request, response) => {
  const method = (request.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    request.resume();
    sendText(response, 405, "METHOD_NOT_ALLOWED", { allow: "GET, HEAD" });
    return;
  }

  let url;
  try {
    url = new URL(request.url ?? "/", `http://${BIND_HOST}:${gatewayPort}`);
  } catch {
    sendText(response, 400, "INVALID_REQUEST_URL");
    return;
  }

  if (!isAllowedPath(url)) {
    sendText(response, 403, "REMOTE_PATH_NOT_ALLOWED");
    return;
  }

  const upstream = http.request(
    {
      hostname: BIND_HOST,
      port: webPort,
      path: `${url.pathname}${url.search}`,
      method,
      headers: safeUpstreamHeaders(request),
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        safeResponseHeaders(upstreamResponse.headers),
      );
      if (method === "HEAD") {
        upstreamResponse.resume();
        response.end();
        return;
      }
      upstreamResponse.pipe(response);
    },
  );

  upstream.setTimeout(5000, () => upstream.destroy(new Error("UPSTREAM_TIMEOUT")));
  upstream.on("error", () => {
    if (!response.headersSent) sendText(response, 502, "LOCAL_WEB_UPSTREAM_UNAVAILABLE");
    else response.destroy();
  });
  upstream.end();
});

server.on("upgrade", (_request, socket) => {
  socket.destroy();
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(gatewayPort, BIND_HOST, () => {
  console.log("PHASE7C_MOBILE_REMOTE_GATEWAY=RUNNING");
  console.log(`BIND=${BIND_HOST}:${gatewayPort}`);
  console.log(`UPSTREAM=http://${BIND_HOST}:${webPort}`);
  console.log("HTTP_METHODS=GET_HEAD_ONLY");
  console.log("REMOTE_PATH_POLICY=EXACT_ALLOWLIST");
  console.log("ORDER_MUTATION=NONE");
  console.log("POSITION_MUTATION=NONE");
  console.log("MODE_MUTATION=NONE");
  console.log("ARM_MUTATION=NONE");
});
