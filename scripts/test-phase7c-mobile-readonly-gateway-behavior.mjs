import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const gatewayScript = path.join(root, "scripts", "run-phase7c-mobile-readonly-gateway.mjs");

function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, pathname, { method = "GET", body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function reservePort() {
  const server = http.createServer();
  const address = await listen(server);
  const port = address.port;
  await close(server);
  return port;
}

const upstreamRequests = [];
const upstream = http.createServer((req, res) => {
  upstreamRequests.push({ method: req.method, url: req.url });
  const body = req.url?.startsWith("/api/") ? JSON.stringify({ ok: true }) : "<html>mobile</html>";
  res.writeHead(200, {
    "content-type": req.url?.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "set-cookie": "must-not-leak=1",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
});

let gateway;
try {
  const upstreamAddress = await listen(upstream);
  const gatewayPort = await reservePort();
  const stdout = [];
  const stderr = [];

  gateway = spawn(process.execPath, [
    gatewayScript,
    "--port", String(gatewayPort),
    "--web-port", String(upstreamAddress.port),
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.setEncoding("utf8");
  gateway.stderr.setEncoding("utf8");
  gateway.stdout.on("data", (chunk) => stdout.push(chunk));
  gateway.stderr.on("data", (chunk) => stderr.push(chunk));

  const deadline = Date.now() + 5000;
  while (!stdout.join("").includes("PHASE7C_MOBILE_REMOTE_GATEWAY=RUNNING")) {
    if (gateway.exitCode !== null) {
      throw new Error(`Gateway exited early code=${gateway.exitCode}. stderr=${stderr.join("")}`);
    }
    if (Date.now() > deadline) throw new Error(`Gateway did not become ready. stderr=${stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  let before = upstreamRequests.length;
  const page = await request(gatewayPort, "/phase7c-mobile");
  assert.equal(page.status, 200);
  assert.match(page.body, /mobile/);
  assert.equal(page.headers["set-cookie"], undefined, "gateway must strip upstream cookies");
  assert.equal(upstreamRequests.length, before + 1);
  assert.deepEqual(upstreamRequests.at(-1), { method: "GET", url: "/phase7c-mobile" });

  before = upstreamRequests.length;
  const head = await request(gatewayPort, "/phase7c-mobile", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(upstreamRequests.length, before + 1);
  assert.deepEqual(upstreamRequests.at(-1), { method: "HEAD", url: "/phase7c-mobile" });

  before = upstreamRequests.length;
  const api = await request(gatewayPort, "/api/v1/mt5/status?symbol=XAUUSD");
  assert.equal(api.status, 200);
  assert.equal(upstreamRequests.length, before + 1);
  assert.deepEqual(upstreamRequests.at(-1), { method: "GET", url: "/api/v1/mt5/status?symbol=XAUUSD" });

  before = upstreamRequests.length;
  const wrongQuery = await request(gatewayPort, "/api/v1/mt5/status?symbol=EURUSD");
  assert.equal(wrongQuery.status, 403);
  assert.equal(upstreamRequests.length, before, "wrong query must not reach upstream");

  before = upstreamRequests.length;
  const blockedRoute = await request(gatewayPort, "/phase7c-control-center");
  assert.equal(blockedRoute.status, 403);
  assert.equal(upstreamRequests.length, before, "blocked UI route must not reach upstream");

  before = upstreamRequests.length;
  const mutation = await request(gatewayPort, "/api/v1/phase7c/bot-mode", {
    method: "POST",
    body: JSON.stringify({ mode: "AUTO" }),
  });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.allow, "GET, HEAD");
  assert.equal(upstreamRequests.length, before, "mutation must not reach upstream");

  before = upstreamRequests.length;
  const allowedPathMutation = await request(gatewayPort, "/api/v1/phase7c/lifecycle", {
    method: "POST",
    body: "{}",
  });
  assert.equal(allowedPathMutation.status, 405);
  assert.equal(upstreamRequests.length, before, "POST to a read-only allowlisted path must not reach upstream");

  console.log("PHASE7C_MOBILE_REMOTE_M2_GATEWAY_BEHAVIOR=PASS");
  console.log("GET_FORWARD=PASS");
  console.log("HEAD_FORWARD=PASS");
  console.log("EXACT_QUERY_GATE=PASS");
  console.log("BLOCKED_ROUTE_403=PASS");
  console.log("MUTATION_405=PASS");
  console.log("UPSTREAM_MUTATION=NONE");
  console.log("UPSTREAM_COOKIE_STRIPPED=PASS");
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway.once("exit", resolve));
  }
  await close(upstream);
}
