import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fingerprintPhase7CRuntimeSourceConfig,
  getPhase7CRuntimeSourceAttestationSnapshot,
  type Phase7CRuntimeSourceDeploymentManifest,
} from "./phase7c-runtime-source-attestation.service";

function sha256File(file: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function createFixture() {
  const tempRoot = mkdtempSync(join(tmpdir(), "phase7c-web-source-attestation-"));
  const runtimeRoot = join(tempRoot, ".runtime");
  const projectRoot = join(tempRoot, "project");
  const attestationRoot = join(runtimeRoot, "phase7c-source-attestation");
  const componentRoot = join(attestationRoot, "components");
  const scriptsRoot = join(projectRoot, "scripts");
  mkdirSync(componentRoot, { recursive: true });
  mkdirSync(scriptsRoot, { recursive: true });

  const configFingerprint = fingerprintPhase7CRuntimeSourceConfig({
    version: 1,
    accountMode: "LIVE",
    liveExecutionEnabled: true,
    runtimeRoot,
    controlApiUrl: "http://127.0.0.1:3711",
  });
  const deployment: Phase7CRuntimeSourceDeploymentManifest = {
    version: 1,
    deploymentId: "0123456789abcdef0123456789abcdef",
    sourceCommit: "3a7fc8f66de0ea78f65a136c4654d335f9503311",
    sourceTree: "2ee3e63a70baf9b0217e1bc006009f46a577f50b",
    branch: "main",
    worktreeClean: true,
    createdAt: 1_788_500_000_000,
    configFingerprint,
  };

  const launcherPath = join(scriptsRoot, "run-phase7b-web-autostart.ps1");
  writeFileSync(launcherPath, "# canonical web launcher\n");
  writeFileSync(join(attestationRoot, "deployment.json"), JSON.stringify(deployment));
  writeFileSync(join(attestationRoot, "web.pid"), "57170\n");
  writeFileSync(join(componentRoot, "web.json"), JSON.stringify({
    version: 1,
    component: "web",
    deploymentId: deployment.deploymentId,
    sourceCommit: deployment.sourceCommit,
    sourceTree: deployment.sourceTree,
    pid: 57170,
    startedAt: deployment.createdAt + 100,
    launcherSha256: sha256File(launcherPath),
    configFingerprint,
  }));

  return { tempRoot, runtimeRoot, projectRoot, attestationRoot, launcherPath };
}

test("web component is exact only when dedicated current PID evidence matches a live attested launcher", () => {
  const fixture = createFixture();
  try {
    const snapshot = getPhase7CRuntimeSourceAttestationSnapshot({
      runtimeRoot: fixture.runtimeRoot,
      projectRoot: fixture.projectRoot,
      apiPid: 99901,
      now: () => 1_788_500_001_000,
      readUtf8: (file) => readFileSync(file, "utf8"),
      sha256File,
      isPidAlive: (pid) => pid === 57170,
    });

    const web = snapshot.components.find((item) => item.component === "web");
    assert.ok(web, "snapshot must include the Web component");
    assert.equal(web.verdict, "EXACT_MATCH");
    assert.equal(web.pid, 57170);
    assert.deepEqual(web.reasonCodes, [
      "DEPLOYMENT_MATCH",
      "PID_MATCH",
      "PROCESS_ALIVE",
      "LAUNCHER_HASH_MATCH",
    ]);
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});

test("missing dedicated Web PID evidence prevents an exact Web verdict", () => {
  const fixture = createFixture();
  try {
    unlinkSync(join(fixture.attestationRoot, "web.pid"));
    const snapshot = getPhase7CRuntimeSourceAttestationSnapshot({
      runtimeRoot: fixture.runtimeRoot,
      projectRoot: fixture.projectRoot,
      apiPid: 99901,
      now: () => 1_788_500_001_000,
      readUtf8: (file) => readFileSync(file, "utf8"),
      sha256File,
      isPidAlive: (pid) => pid === 57170,
    });

    const web = snapshot.components.find((item) => item.component === "web");
    assert.ok(web, "snapshot must include the Web component even when PID evidence is missing");
    assert.notEqual(web.verdict, "EXACT_MATCH");
    assert.ok(web.reasonCodes.includes("CURRENT_PID_MISSING"));
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
});
