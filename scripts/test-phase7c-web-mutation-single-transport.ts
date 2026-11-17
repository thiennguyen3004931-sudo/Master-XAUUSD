import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function fail(reason: string): never {
  console.error("PHASE7C_WEB_MUTATION_SINGLE_TRANSPORT=FAIL");
  console.error(`REASON=${reason}`);
  process.exit(1);
}

async function expectReject(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected request to reject with Error");
  assert.match(error.message, pattern);
}

async function main() {
  const transportPath = resolve(root, "apps/web/src/local-control-request.ts");
  let transportModule: any;
  try {
    transportModule = await import(pathToFileURL(transportPath).href);
  } catch (error) {
    fail(`TRANSPORT_MODULE_MISSING_OR_INVALID:${error instanceof Error ? error.message : String(error)}`);
  }

  const requestLocalControlJson = transportModule.requestLocalControlJson as
    | (<T>(path: string, init?: RequestInit, fetchImpl?: typeof fetch) => Promise<T>)
    | undefined;
  if (typeof requestLocalControlJson !== "function") {
    fail("REQUEST_LOCAL_CONTROL_JSON_EXPORT_MISSING");
  }

  {
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) throw new TypeError("proxy transport unavailable");
      return new Response(JSON.stringify({ ok: true, source: "direct" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await requestLocalControlJson<{ ok: boolean; source: string }>(
      "/api/v1/test-read",
      undefined,
      fakeFetch,
    );
    assert.deepEqual(result, { ok: true, source: "direct" });
    assert.deepEqual(calls, [
      "/api/v1/test-read",
      "http://127.0.0.1:3711/api/v1/test-read",
    ]);
  }

  {
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      calls.push(String(input));
      throw new TypeError("response lost after mutation may have reached server");
    }) as typeof fetch;

    await expectReject(
      requestLocalControlJson(
        "/api/v1/test-mutation",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: 1 }),
        },
        fakeFetch,
      ),
      /response lost after mutation may have reached server/i,
    );
    assert.deepEqual(calls, ["/api/v1/test-mutation"]);
  }

  {
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: "server rejected mutation" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expectReject(
      requestLocalControlJson(
        "/api/v1/test-http-mutation",
        { method: "POST", body: "{}" },
        fakeFetch,
      ),
      /server rejected mutation/i,
    );
    assert.deepEqual(calls, ["/api/v1/test-http-mutation"]);
  }

  {
    const calls: string[] = [];
    const fakeFetch = (async (input: any) => {
      const url = String(input);
      calls.push(url);
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "proxy read failed" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await requestLocalControlJson<{ ok: boolean }>(
      "/api/v1/test-read-http-fallback",
      { method: "GET" },
      fakeFetch,
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 2);
  }

  const executionControlPath = resolve(root, "apps/web/src/phase7c-execution-control.ts");
  const accountSwitchPath = resolve(root, "apps/web/src/ui/Phase7CAccountSwitchCard.tsx");
  const executionControl = readFileSync(executionControlPath, "utf8");
  const accountSwitch = readFileSync(accountSwitchPath, "utf8");

  assert.match(executionControl, /requestLocalControlJson/);
  assert.match(accountSwitch, /requestLocalControlJson/);
  assert.doesNotMatch(executionControl, /const\s+CONTROL_DIRECT\s*=|const\s+urls\s*=\s*\[/);
  assert.doesNotMatch(accountSwitch, /const\s+CONTROL_DIRECT\s*=|const\s+urls\s*=\s*\[/);

  for (const backendPath of [
    resolve(root, "apps/api/src/services/phase7c-account-switch.service.ts"),
    resolve(root, "apps/api/src/services/phase7c-live-arm-control.service.ts"),
  ]) {
    const source = readFileSync(backendPath, "utf8");
    const lookupIndex = source.indexOf("preflightTokens.get(input.preflightToken)");
    const deleteIndex = source.indexOf("preflightTokens.delete(input.preflightToken)");
    const requestWriteIndex = source.indexOf("atomicWriteJson(requestPath()");
    assert.ok(lookupIndex >= 0, `${backendPath}: preflight token lookup missing`);
    assert.ok(deleteIndex > lookupIndex, `${backendPath}: token must be consumed after lookup`);
    assert.ok(requestWriteIndex > deleteIndex, `${backendPath}: token must be consumed before request mutation`);
  }

  console.log("PHASE7C_WEB_MUTATION_SINGLE_TRANSPORT=PASS");
  console.log("READ_ONLY_FALLBACK=RELATIVE_THEN_DIRECT");
  console.log("MUTATION_TRANSPORT_ATTEMPTS=1");
  console.log("PREFLIGHT_TOKEN_CONSUMPTION=ONE_SHOT");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
