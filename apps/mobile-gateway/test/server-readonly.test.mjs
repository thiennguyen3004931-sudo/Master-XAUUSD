import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMobileGatewayServer } = require("../server.cjs");
const TEST_USER = "operator@example.com";

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address();
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function request(origin, method, path, headers = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers, redirect: "manual" });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

test("preserves accepted M2 read-only gateway semantics", async () => {
  const upstream = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    if (req.method !== "HEAD") res.end(`WEB:${req.method}:${req.url}`);
    else res.end();
  });
  const upstreamAddress = await listen(upstream);
  const webOrigin = `http://127.0.0.1:${upstreamAddress.port}`;

  const gateway = createMobileGatewayServer({
    config: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      webOrigin,
      allowedUsers: [TEST_USER],
    },
  });
  const gatewayAddress = await listen(gateway);
  const gatewayOrigin = `http://127.0.0.1:${gatewayAddress.port}`;
  const trustedHeaders = { "tailscale-user-login": TEST_USER };

  try {
    assert.equal(gatewayAddress.address, "127.0.0.1");

    const health = await request(gatewayOrigin, "GET", "/__m2/health");
    assert.equal(health.status, 200);

    const getPage = await request(gatewayOrigin, "GET", "/phase7c-mobile", trustedHeaders);
    assert.equal(getPage.status, 200);
    assert.equal(getPage.text, "WEB:GET:/phase7c-mobile");

    const headPage = await request(gatewayOrigin, "HEAD", "/phase7c-mobile", trustedHeaders);
    assert.equal(headPage.status, 200);

    const missingIdentity = await request(gatewayOrigin, "GET", "/phase7c-mobile");
    assert.equal(missingIdentity.status, 403);

    const blockedPost = await request(gatewayOrigin, "POST", "/phase7c-mobile", trustedHeaders);
    assert.equal(blockedPost.status, 405);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test("does not forward Tailscale identity headers to Web upstream", async () => {
  let forwardedIdentity = null;
  const upstream = http.createServer((req, res) => {
    forwardedIdentity = req.headers["tailscale-user-login"] ?? null;
    res.statusCode = 200;
    res.end("OK");
  });
  const upstreamAddress = await listen(upstream);

  const gateway = createMobileGatewayServer({
    config: {
      listenHost: "127.0.0.1",
      listenPort: 0,
      webOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      allowedUsers: [TEST_USER],
    },
  });
  const gatewayAddress = await listen(gateway);

  try {
    const result = await request(
      `http://127.0.0.1:${gatewayAddress.port}`,
      "GET",
      "/phase7c-mobile",
      { "tailscale-user-login": TEST_USER },
    );
    assert.equal(result.status, 200);
    assert.equal(forwardedIdentity, null);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
