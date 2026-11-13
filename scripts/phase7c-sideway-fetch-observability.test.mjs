import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const controllerPath = path.join(here, "run-phase7c-sideway-controller.mjs");
const controllerSource = fs.readFileSync(controllerPath, "utf8");

function loadJsonRequest(fakeFetch) {
  const start = controllerSource.indexOf("async function jsonRequest(");
  const end = controllerSource.indexOf("\nfunction validateVolume", start);
  assert.ok(start >= 0, "Sideway controller must define jsonRequest().");
  assert.ok(end > start, "Sideway jsonRequest() source boundary must remain discoverable.");

  const functionSource = controllerSource.slice(start, end).trim();
  const factory = new Function(
    "fetch",
    "AbortController",
    "setTimeout",
    "clearTimeout",
    `${functionSource}\nreturn jsonRequest;`,
  );
  return factory(fakeFetch, AbortController, setTimeout, clearTimeout);
}

function transportError(message, code) {
  const cause = Object.assign(new Error(`${code} synthetic transport cause`), { code });
  return new TypeError(message, { cause });
}

test("Sideway fetch transport failures identify component, method, safe pathname, and cause code", async () => {
  const jsonRequest = loadJsonRequest(async () => {
    throw transportError("fetch failed", "ECONNREFUSED");
  });

  await assert.rejects(
    () => jsonRequest(
      "http://127.0.0.1:8765/v1/quotes/XAUUSD?apiKey=QUERY_SECRET&count=320",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-mt5-api-key": "HEADER_SECRET",
        },
      },
      10_000,
      "MT5 bridge",
    ),
    (error) => {
      assert.match(error.message, /^MT5 bridge GET \/v1\/quotes\/XAUUSD \| transport=fetch failed/);
      assert.match(error.message, /\| cause=ECONNREFUSED$/);
      assert.doesNotMatch(error.message, /QUERY_SECRET|HEADER_SECRET|apiKey=|count=320|127\.0\.0\.1:8765/);
      return true;
    },
  );
});

test("Sideway response-body transport failures keep the same safe request context", async () => {
  const jsonRequest = loadJsonRequest(async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw transportError("fetch failed", "ECONNRESET");
    },
  }));

  await assert.rejects(
    () => jsonRequest(
      "http://127.0.0.1:8765/v1/candles/XAUUSD?timeframe=M5&count=120",
      { method: "GET", headers: { "x-mt5-api-key": "HEADER_SECRET" } },
      10_000,
      "MT5 bridge",
    ),
    (error) => {
      assert.equal(
        error.message,
        "MT5 bridge GET /v1/candles/XAUUSD | transport=fetch failed | cause=ECONNRESET",
      );
      assert.doesNotMatch(error.message, /HEADER_SECRET|timeframe=|count=|127\.0\.0\.1:8765/);
      return true;
    },
  );
});

test("Sideway request timeout is explicit without leaking query data", async () => {
  const jsonRequest = loadJsonRequest(
    async (_url, init) => new Promise((resolve, reject) => {
      void resolve;
      init.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  );

  await assert.rejects(
    () => jsonRequest(
      "http://127.0.0.1:3711/api/v1/phase7c/live-regime?symbol=XAUUSD&count=320&token=QUERY_SECRET",
      { method: "GET", headers: { accept: "application/json" } },
      5,
      "Phase7C control API",
    ),
    (error) => {
      assert.equal(
        error.message,
        "Phase7C control API GET /api/v1/phase7c/live-regime | timeout=5ms",
      );
      assert.doesNotMatch(error.message, /QUERY_SECRET|symbol=|count=|token=|127\.0\.0\.1:3711/);
      return true;
    },
  );
});

test("Sideway non-2xx response semantics stay unchanged", async () => {
  const jsonRequest = loadJsonRequest(async () => ({
    ok: false,
    status: 503,
    text: async () => "maintenance",
  }));

  await assert.rejects(
    () => jsonRequest(
      "http://127.0.0.1:3711/api/v1/phase7c/live-regime?symbol=XAUUSD",
      { method: "GET", headers: { accept: "application/json" } },
      5_000,
      "Phase7C control API",
    ),
    {
      message: "Phase7C control API 503: maintenance",
    },
  );
});
