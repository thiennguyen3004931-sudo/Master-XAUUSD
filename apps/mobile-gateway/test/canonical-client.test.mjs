import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCanonicalClient } = require("../canonical-client.cjs");

function makeHarness(payload = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

test("MODE_AUTO uses canonical AUTO activation service, never bot-mode directly", async () => {
  const { calls, fetchImpl } = makeHarness({ approved: true });
  const client = createCanonicalClient({ apiOrigin: "http://127.0.0.1:3711", fetchImpl, timeoutMs: 1000 });

  await client.executeModeAction("MODE_AUTO");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3711/api/v1/phase7c-auto-activation/enable");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}");
  assert.equal(calls[0].url.includes("/phase7c/bot-mode"), false);
});

test("non-AUTO mode actions use fixed canonical bot-mode body", async () => {
  for (const [action, mode] of [
    ["MODE_SEMI", "SEMI"],
    ["MODE_TREND", "TREND"],
    ["MODE_SIDEWAY", "SIDEWAY"],
    ["MODE_PAUSE", "PAUSE"],
  ]) {
    const { calls, fetchImpl } = makeHarness({ state: { mode } });
    const client = createCanonicalClient({ apiOrigin: "http://127.0.0.1:3711", fetchImpl, timeoutMs: 1000 });
    await client.executeModeAction(action);
    assert.equal(calls.length, 1, action);
    assert.equal(calls[0].url, "http://127.0.0.1:3711/api/v1/phase7c/bot-mode", action);
    assert.deepEqual(JSON.parse(calls[0].init.body), { mode, source: "mobile-control-center" }, action);
  }
});

test("AUTO readiness is a fixed GET endpoint", async () => {
  const { calls, fetchImpl } = makeHarness({ approved: false });
  const client = createCanonicalClient({ apiOrigin: "http://127.0.0.1:3711", fetchImpl, timeoutMs: 1000 });
  await client.getAutoStatus();
  assert.equal(calls[0].url, "http://127.0.0.1:3711/api/v1/phase7c-auto-activation/status");
  assert.equal(calls[0].init.method, "GET");
});

test("ARM/DISARM client exposes only fixed capability/preflight/execute/status paths", async () => {
  const { calls, fetchImpl } = makeHarness({ ok: true });
  const client = createCanonicalClient({ apiOrigin: "http://127.0.0.1:3711", fetchImpl, timeoutMs: 1000 });

  await client.getArmCapability();
  await client.createArmPreflight("ARM_LIVE");
  await client.executeArm("ARM_LIVE", "secret-token");
  await client.getArmStatus("req 1");

  assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [
    ["GET", "http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/capability"],
    ["POST", "http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/preflight"],
    ["POST", "http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/execute"],
    ["GET", "http://127.0.0.1:3711/api/v1/phase7c-live-arm-control/status?requestId=req%201"],
  ]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: "ARM_LIVE" });
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    action: "ARM_LIVE",
    preflightToken: "secret-token",
    confirmation: "ARM_LIVE",
  });
});

test("canonical non-2xx response is propagated as failure", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "blocked" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  });
  const client = createCanonicalClient({ apiOrigin: "http://127.0.0.1:3711", fetchImpl, timeoutMs: 1000 });
  await assert.rejects(() => client.executeModeAction("MODE_AUTO"), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /blocked/);
    return true;
  });
});
