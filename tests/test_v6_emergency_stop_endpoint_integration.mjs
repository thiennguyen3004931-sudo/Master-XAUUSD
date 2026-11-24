import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "v6-estop-endpoint-"));
process.env.V6_RUNTIME_DIR = runtime;
process.env.ZIQ_V6_CONTROL_TOKEN = "test-control-token";
process.env.API_PORT = "0";
process.env.WEB_PORT = "0";
const server = await import("../scripts/xauusd-standalone-server.mjs");

function bodyStream(text) {
  return {
    on(event, callback) {
      if (event === "data") callback(Buffer.from(text));
      if (event === "end") callback();
    },
  };
}

async function callApi(url, body) {
  const encoded = JSON.stringify(body);
  let status = 0;
  let output = "";
  const headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(encoded)),
    "x-v6-control-token": "test-control-token",
    "x-v6-nonce": crypto.randomBytes(16).toString("hex"),
    "x-v6-timestamp": String(Date.now()),
  };
  await server.handleApiRequest(
    { method: "POST", url, headers, socket: { remoteAddress: "127.0.0.1" }, ...bodyStream(encoded) },
    { writeHead(code) { status = code; }, end(value) { output = String(value || ""); } },
  );
  return { status, data: JSON.parse(output || "{}") };
}

test("Emergency Stop endpoint persists intent and account-bound latch before success", async () => {
  server.setMt5EngineInvokerForTest(() => ({
    connected: true,
    accountLogin: 5201362,
    server: "DBGMarkets-Live",
    accountMode: "LIVE",
    brokerSymbol: "XAUUSD.G",
    dailyRiskState: { ok: true },
  }));
  const connect = await callApi("/api/v1/mt5/connect-account", {
    accountMode: "LIVE", login: "5201362", server: "DBGMarkets-Live", brokerSymbol: "XAUUSD.G",
  });
  assert.equal(connect.status, 200);

  const stopped = await callApi("/api/v1/mt5/emergency-stop", { reason: "TEST_STOP" });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.emergencyStop.durable, true);

  const intent = JSON.parse(fs.readFileSync(path.join(runtime, "v6-stop-intent.flag"), "utf8"));
  const latch = JSON.parse(fs.readFileSync(path.join(runtime, "v6-emergency-stop-latch.json"), "utf8"));
  assert.equal(intent.stopIntentActive, true);
  assert.equal(intent.accountLogin, 5201362);
  assert.equal(intent.server, "DBGMarkets-Live");
  assert.equal(latch.emergencyStopActive, true);
  assert.equal(latch.blockNewOrders, true);
  assert.equal(latch.allowProtectivePositionManagement, true);
  assert.equal(latch.stopCategory, "OPERATOR_EMERGENCY_STOP");
  assert.equal(latch.stopRevision, intent.stopRevision);
});
