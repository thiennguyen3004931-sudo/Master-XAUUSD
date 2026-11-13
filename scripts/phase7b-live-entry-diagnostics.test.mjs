import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function loadPolicy() {
  try {
    return await import("../apps/api/src/services/phase7b-entry-diagnostics-account-mode.ts");
  } catch (error) {
    return {
      shouldComputePhase7BEntryDiagnostics: () => false,
      __loadError: error,
    };
  }
}

test("reachable LIVE/real telemetry enables canonical entry diagnostics", async () => {
  const policy = await loadPolicy();
  const actual = policy.shouldComputePhase7BEntryDiagnostics({
    reachable: true,
    accountMode: "real",
  });

  assert.equal(
    actual,
    true,
    policy.__loadError
      ? `Expected LIVE diagnostics policy module to exist and allow real accounts: ${policy.__loadError}`
      : undefined,
  );
});

test("reachable DEMO telemetry keeps canonical entry diagnostics enabled", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: "demo" }), true);
});

test("unsupported or malformed account modes stay fail-closed", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: "contest" }), false);
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: "REAL" }), false);
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: "" }), false);
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: null }), false);
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: true, accountMode: undefined }), false);
});

test("unreachable telemetry never computes canonical entry diagnostics", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: false, accountMode: "real" }), false);
  assert.equal(policy.shouldComputePhase7BEntryDiagnostics({ reachable: false, accountMode: "demo" }), false);
});

test("Phase7B status route delegates its diagnostics account-mode decision to the shared policy", () => {
  const source = readFileSync(
    new URL("../apps/api/src/routes/phase7b-demo.route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /shouldComputePhase7BEntryDiagnostics\s*\(\s*\{[\s\S]*?reachable:\s*telemetry\.reachable[\s\S]*?accountMode:\s*telemetry\.health\?\.accountMode\s*\?\?\s*null[\s\S]*?\}\s*\)/,
  );
});
