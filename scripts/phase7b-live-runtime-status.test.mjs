import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function loadRuntimePolicy() {
  try {
    return await import("../apps/api/src/services/phase7b-status-runtime-account-mode.ts");
  } catch (error) {
    return {
      phase7BForwardRuntimeDirName: () => "phase7b-demo-forward",
      __loadError: error,
    };
  }
}

async function loadProcessLivenessPolicy() {
  try {
    return await import("../apps/api/src/services/phase7b-process-liveness.ts");
  } catch (error) {
    return {
      isPhase7BProcessAlive: () => false,
      __loadError: error,
    };
  }
}

test("LIVE/real status resolves the Phase7B LIVE forward runtime", async () => {
  const policy = await loadRuntimePolicy();
  const actual = policy.phase7BForwardRuntimeDirName("real");

  assert.equal(
    actual,
    "phase7b-live-forward",
    policy.__loadError
      ? `Expected account-aware Phase7B runtime policy to exist: ${policy.__loadError}`
      : undefined,
  );
});

test("DEMO status keeps the Phase7B DEMO forward runtime", async () => {
  const policy = await loadRuntimePolicy();
  assert.equal(policy.phase7BForwardRuntimeDirName("demo"), "phase7b-demo-forward");
});

test("unknown broker account modes stay fail-closed on DEMO status runtime", async () => {
  const policy = await loadRuntimePolicy();
  assert.equal(policy.phase7BForwardRuntimeDirName("contest"), "phase7b-demo-forward");
  assert.equal(policy.phase7BForwardRuntimeDirName(""), "phase7b-demo-forward");
  assert.equal(policy.phase7BForwardRuntimeDirName(null), "phase7b-demo-forward");
  assert.equal(policy.phase7BForwardRuntimeDirName(undefined), "phase7b-demo-forward");
});

test("EPERM from a PID probe still means the process exists", async () => {
  const policy = await loadProcessLivenessPolicy();
  const permissionError = Object.assign(new Error("operation not permitted"), {
    code: "EPERM",
  });

  const actual = policy.isPhase7BProcessAlive(15384, () => {
    throw permissionError;
  });

  assert.equal(
    actual,
    true,
    policy.__loadError
      ? `Expected permission-aware Phase7B liveness policy to exist: ${policy.__loadError}`
      : undefined,
  );
});

test("ESRCH from a PID probe means the process does not exist", async () => {
  const policy = await loadProcessLivenessPolicy();
  const missingError = Object.assign(new Error("no such process"), {
    code: "ESRCH",
  });

  assert.equal(
    policy.isPhase7BProcessAlive(15384, () => {
      throw missingError;
    }),
    false,
  );
});

test("invalid PIDs stay fail-closed without probing", async () => {
  const policy = await loadProcessLivenessPolicy();
  let probes = 0;
  const probe = () => {
    probes += 1;
  };

  assert.equal(policy.isPhase7BProcessAlive(null, probe), false);
  assert.equal(policy.isPhase7BProcessAlive(0, probe), false);
  assert.equal(policy.isPhase7BProcessAlive(-1, probe), false);
  assert.equal(policy.isPhase7BProcessAlive(1.5, probe), false);
  assert.equal(probes, 0);
});

test("Phase7B status route selects runtime from broker account mode", () => {
  const source = readFileSync(
    new URL("../apps/api/src/routes/phase7b-demo.route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /findLatestDemoDir\s*\(\s*telemetry\.health\?\.accountMode\s*\?\?\s*null\s*\)/,
  );
  assert.match(source, /phase7BForwardRuntimeDirName/);
});

test("Phase7B status route uses the permission-aware liveness policy", () => {
  const source = readFileSync(
    new URL("../apps/api/src/routes/phase7b-demo.route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /isPhase7BProcessAlive/);
  assert.doesNotMatch(source, /function\s+isPidAlive\s*\(/);
});
