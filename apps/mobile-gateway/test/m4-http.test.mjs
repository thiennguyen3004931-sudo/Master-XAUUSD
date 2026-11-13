import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createMobileGatewayServer } = require("../server.cjs");
const { validateProductionConfig } = require("../gateway.js");

const ORIGIN = "https://test-device.example-tailnet.ts.net:8443";
const USER = "operator@example.com";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function config() {
  return {
    listenHost: "127.0.0.1",
    listenPort: 5791,
    webOrigin: "http://127.0.0.1:5717",
    apiOrigin: "http://127.0.0.1:3711",
    allowedUsers: [USER],
    allowedOrigin: ORIGIN,
    auditPath: "C:\\ProgramData\\XAUUSD-AI-MASTER\\mobile-readonly-gateway\\m4-audit.jsonl",
  };
}

function makeBroker() {
  const calls = [];
  return {
    calls,
    async getState(identity) {
      calls.push(["state", identity]);
      return { mode: "PAUSE", liveArmStatus: "DISARMED" };
    },
    async handleAction(identity, body) {
      calls.push(["action", identity, body]);
      return { action: body.action, outcome: "PASS" };
    },
    async getTransactionStatus(identity, transactionId) {
      calls.push(["status", identity, transactionId]);
      return { transactionId, status: "RUNNING" };
    },
  };
}

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, json, text };
}

test("mutation requires authorized Tailscale identity and exact HTTPS Origin", async () => {
  const broker = makeBroker();
  const server = createMobileGatewayServer({ config: config(), broker, fetchImpl: fetch });
  const base = await listen(server);
  try {
    const body = JSON.stringify({ action: "MODE_PAUSE", confirmation: "MODE_PAUSE" });
    for (const headers of [
      { "content-type": "application/json", origin: ORIGIN },
      { "content-type": "application/json", origin: ORIGIN, "tailscale-user-login": "other@example.com" },
      { "content-type": "application/json", "tailscale-user-login": USER },
      { "content-type": "application/json", origin: "https://wrong.example", "tailscale-user-login": USER },
    ]) {
      const result = await request(base, "/__m4/action", { method: "POST", headers, body });
      assert.equal(result.status, 403);
    }
    assert.equal(broker.calls.length, 0);

    const accepted = await request(base, "/__m4/action", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "tailscale-user-login": USER },
      body,
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(broker.calls[0], ["action", USER, { action: "MODE_PAUSE", confirmation: "MODE_PAUSE" }]);
  } finally {
    await close(server);
  }
});

test("M4 action is POST-only and other mutation surfaces remain blocked", async () => {
  const broker = makeBroker();
  const server = createMobileGatewayServer({ config: config(), broker, fetchImpl: fetch });
  const base = await listen(server);
  try {
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const result = await request(base, "/__m4/action", {
        method,
        headers: { origin: ORIGIN, "tailscale-user-login": USER },
      });
      assert.equal(result.status, 405, method);
    }
    const directApiPost = await request(base, "/api/v1/phase7c/bot-mode", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "tailscale-user-login": USER },
      body: "{}",
    });
    assert.equal(directApiPost.status, 405);
    assert.equal(broker.calls.length, 0);
  } finally {
    await close(server);
  }
});

test("bounded state and transaction status require identity", async () => {
  const broker = makeBroker();
  const server = createMobileGatewayServer({ config: config(), broker, fetchImpl: fetch });
  const base = await listen(server);
  try {
    assert.equal((await request(base, "/__m4/state")).status, 403);
    assert.equal((await request(base, "/__m4/status?transactionId=tx-1")).status, 403);

    const state = await request(base, "/__m4/state", { headers: { "tailscale-user-login": USER } });
    assert.equal(state.status, 200);
    assert.equal(state.json.mode, "PAUSE");

    const status = await request(base, "/__m4/status?transactionId=tx-1", { headers: { "tailscale-user-login": USER } });
    assert.equal(status.status, 200);
    assert.equal(status.json.transactionId, "tx-1");
  } finally {
    await close(server);
  }
});

test("strict JSON handling rejects wrong content type, malformed and oversized bodies", async () => {
  const broker = makeBroker();
  const server = createMobileGatewayServer({ config: config(), broker, fetchImpl: fetch });
  const base = await listen(server);
  const auth = { origin: ORIGIN, "tailscale-user-login": USER };
  try {
    assert.equal((await request(base, "/__m4/action", { method: "POST", headers: auth, body: "{}" })).status, 415);
    assert.equal((await request(base, "/__m4/action", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{bad",
    })).status, 400);
    assert.equal((await request(base, "/__m4/action", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ x: "a".repeat(9000) }),
    })).status, 413);
    assert.equal(broker.calls.length, 0);
  } finally {
    await close(server);
  }
});

test("production config is fail-closed for exposure and authorization settings", () => {
  assert.doesNotThrow(() => validateProductionConfig(config()));
  assert.throws(() => validateProductionConfig({ ...config(), listenHost: "0.0.0.0" }), /LOOPBACK/);
  assert.throws(() => validateProductionConfig({ ...config(), apiOrigin: "http://192.168.1.5:3711" }), /API_ORIGIN/);
  assert.throws(() => validateProductionConfig({ ...config(), webOrigin: "http://192.168.1.5:5717" }), /WEB_ORIGIN/);
  assert.throws(() => validateProductionConfig({ ...config(), allowedUsers: [] }), /ALLOWED_USERS/);
  assert.throws(() => validateProductionConfig({ ...config(), allowedOrigin: "http://example.test" }), /ALLOWED_ORIGIN/);
});
