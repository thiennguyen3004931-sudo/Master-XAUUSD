import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  combinePhase7CRuntimeSourceVerdicts,
  evaluatePhase7CRuntimeSourceComponent,
  fingerprintPhase7CRuntimeSourceConfig,
  getPhase7CRuntimeSourceAttestationSnapshot,
  type Phase7CRuntimeSourceComponentEvaluationInput,
  type Phase7CRuntimeSourceDeploymentManifest,
} from "./phase7c-runtime-source-attestation.service";

const deployment: Phase7CRuntimeSourceDeploymentManifest = {
  version: 1,
  deploymentId: "0123456789abcdef0123456789abcdef",
  sourceCommit: "4f156ef1b019ef676cc23ed978c9487eb41f2fe6",
  sourceTree: "0ab41605d0ccdf0b17210826081ce4bd9e3a5620",
  branch: "main",
  worktreeClean: true,
  createdAt: 1_788_475_565_000,
  configFingerprint: "sha256:ad7ecee6a3c038992ba8816bf8ec8235bc2febbdad35fcd07a35c511512445d9",
};

const exactInput = (): Phase7CRuntimeSourceComponentEvaluationInput => ({
  component: "trend",
  deployment,
  attestation: {
    version: 1,
    component: "trend",
    deploymentId: deployment.deploymentId,
    sourceCommit: deployment.sourceCommit,
    sourceTree: deployment.sourceTree,
    pid: 12345,
    startedAt: 1_788_475_565_100,
    launcherSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    configFingerprint: deployment.configFingerprint,
  },
  currentPid: 12345,
  currentPidAlive: true,
  attestedPidAlive: true,
  expectedLauncherSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evidenceErrors: [],
});

test("fingerprint fixture is cross-language stable", () => {
  assert.equal(
    fingerprintPhase7CRuntimeSourceConfig({
      version: 1,
      accountMode: "LIVE",
      liveExecutionEnabled: true,
      runtimeRoot: "F:\\Project\\XAUUSD_AI_MASTER\\xauusd-ai-master\\.runtime",
      controlApiUrl: "http://127.0.0.1:3711",
    }),
    "sha256:ad7ecee6a3c038992ba8816bf8ec8235bc2febbdad35fcd07a35c511512445d9",
  );
});

test("overall precedence is mismatch then unknown then stale then exact", () => {
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["EXACT_MATCH", "STALE"]), "STALE");
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["STALE", "UNKNOWN"]), "UNKNOWN");
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["UNKNOWN", "MISMATCH"]), "MISMATCH");
  assert.equal(combinePhase7CRuntimeSourceVerdicts(["EXACT_MATCH", "EXACT_MATCH"]), "EXACT_MATCH");
});

test("exact component evidence is exact", () => {
  const result = evaluatePhase7CRuntimeSourceComponent(exactInput());
  assert.equal(result.verdict, "EXACT_MATCH");
  assert.deepEqual(result.reasonCodes, [
    "DEPLOYMENT_MATCH",
    "PID_MATCH",
    "PROCESS_ALIVE",
    "LAUNCHER_HASH_MATCH",
  ]);
});

test("wrong deployment identity fields are mismatch", () => {
  for (const [name, mutate] of [
    ["commit", (input: Phase7CRuntimeSourceComponentEvaluationInput) => { input.attestation!.sourceCommit = "1111111111111111111111111111111111111111"; }],
    ["tree", (input: Phase7CRuntimeSourceComponentEvaluationInput) => { input.attestation!.sourceTree = "2222222222222222222222222222222222222222"; }],
    ["deployment", (input: Phase7CRuntimeSourceComponentEvaluationInput) => { input.attestation!.deploymentId = "ffffffffffffffffffffffffffffffff"; }],
    ["config", (input: Phase7CRuntimeSourceComponentEvaluationInput) => { input.attestation!.configFingerprint = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }],
    ["component", (input: Phase7CRuntimeSourceComponentEvaluationInput) => { input.attestation!.component = "sideway"; }],
  ] as const) {
    const input = exactInput();
    mutate(input);
    assert.equal(evaluatePhase7CRuntimeSourceComponent(input).verdict, "MISMATCH", name);
  }
});

test("launcher hash mismatch is mismatch", () => {
  const input = exactInput();
  input.expectedLauncherSha256 = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  const result = evaluatePhase7CRuntimeSourceComponent(input);
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.reasonCodes.includes("LAUNCHER_HASH_MISMATCH"));
});

test("different current live pid is mismatch", () => {
  const input = exactInput();
  input.currentPid = 54321;
  input.currentPidAlive = true;
  const result = evaluatePhase7CRuntimeSourceComponent(input);
  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.reasonCodes.includes("PID_MISMATCH"));
});

test("dead historical attestation with no current live pid is stale", () => {
  const input = exactInput();
  input.currentPid = null;
  input.currentPidAlive = null;
  input.attestedPidAlive = false;
  const result = evaluatePhase7CRuntimeSourceComponent(input);
  assert.equal(result.verdict, "STALE");
  assert.ok(result.reasonCodes.includes("ATTESTED_PID_DEAD"));
});

test("dead previous-deployment attestation with no current live pid is stale", () => {
  const input = exactInput();
  input.attestation!.sourceCommit = "1111111111111111111111111111111111111111";
  input.attestation!.sourceTree = "2222222222222222222222222222222222222222";
  input.attestation!.deploymentId = "ffffffffffffffffffffffffffffffff";
  input.currentPid = null;
  input.currentPidAlive = null;
  input.attestedPidAlive = false;

  const result = evaluatePhase7CRuntimeSourceComponent(input);

  assert.equal(result.verdict, "STALE");
  assert.ok(result.reasonCodes.includes("ATTESTED_PID_DEAD"));
});

test("live previous-deployment attestation remains mismatch", () => {
  const input = exactInput();
  input.attestation!.sourceCommit = "1111111111111111111111111111111111111111";
  input.attestation!.sourceTree = "2222222222222222222222222222222222222222";
  input.attestation!.deploymentId = "ffffffffffffffffffffffffffffffff";

  const result = evaluatePhase7CRuntimeSourceComponent(input);

  assert.equal(result.verdict, "MISMATCH");
  assert.ok(result.reasonCodes.includes("SOURCE_COMMIT_MISMATCH"));
  assert.ok(result.reasonCodes.includes("SOURCE_TREE_MISMATCH"));
  assert.ok(result.reasonCodes.includes("DEPLOYMENT_ID_MISMATCH"));
});

test("missing or invalid evidence is unknown", () => {
  const missingManifest = exactInput();
  missingManifest.deployment = null;
  assert.equal(evaluatePhase7CRuntimeSourceComponent(missingManifest).verdict, "UNKNOWN");

  const missingAttestation = exactInput();
  missingAttestation.attestation = null;
  assert.equal(evaluatePhase7CRuntimeSourceComponent(missingAttestation).verdict, "UNKNOWN");

  const unresolvedPid = exactInput();
  unresolvedPid.currentPid = null;
  unresolvedPid.currentPidAlive = null;
  unresolvedPid.attestedPidAlive = null;
  assert.equal(evaluatePhase7CRuntimeSourceComponent(unresolvedPid).verdict, "UNKNOWN");

  const readError = exactInput();
  readError.evidenceErrors = ["EVIDENCE_INVALID"];
  assert.equal(evaluatePhase7CRuntimeSourceComponent(readError).verdict, "UNKNOWN");
});

test("complete read-only snapshot reports all eight exact components", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "phase7c-runtime-source-snapshot-"));
  try {
    const runtimeRoot = join(tempRoot, ".runtime");
    const projectRoot = join(tempRoot, "project");
    const attestationRoot = join(runtimeRoot, "phase7c-source-attestation");
    const componentRoot = join(attestationRoot, "components");
    const executorRoot = join(runtimeRoot, "phase7c-executors");
    const brokerStateRoot = join(runtimeRoot, "phase7c-lifecycle-broker", "state");
    const scriptsRoot = join(projectRoot, "scripts");
    mkdirSync(componentRoot, { recursive: true });
    mkdirSync(executorRoot, { recursive: true });
    mkdirSync(brokerStateRoot, { recursive: true });
    mkdirSync(scriptsRoot, { recursive: true });

    const components = [
      ["api", 4101, "run-phase7b-api-runtime-local.ps1"],
      ["web", 4108, "run-phase7b-web-autostart.ps1"],
      ["lifecycle-broker", 4102, "run-phase7c-executor-task-runner-local.ps1"],
      ["supervisor", 4103, "run-phase7c-executors-local.ps1"],
      ["trend", 4104, "run-phase7c-trend-controller-local.ps1"],
      ["sideway", 4105, "run-phase7c-sideway-controller-local.ps1"],
      ["telegram", 4106, "run-phase7c-telegram-mode-controller-local.ps1"],
      ["regime-notifier", 4107, "run-phase7c-regime-notifier-local.ps1"],
    ] as const;

    writeFileSync(join(attestationRoot, "deployment.json"), JSON.stringify(deployment));
    for (const [component, pid, launcher] of components) {
      const launcherPath = join(scriptsRoot, launcher);
      writeFileSync(launcherPath, `${component}\n`);
      const launcherSha256 = `sha256:${String(pid % 10).repeat(64)}`;
      writeFileSync(join(componentRoot, `${component}.json`), JSON.stringify({
        version: 1,
        component,
        deploymentId: deployment.deploymentId,
        sourceCommit: deployment.sourceCommit,
        sourceTree: deployment.sourceTree,
        pid,
        startedAt: deployment.createdAt + pid,
        launcherSha256,
        configFingerprint: deployment.configFingerprint,
      }));
    }

    writeFileSync(join(attestationRoot, "web.pid"), "4108\n");
    writeFileSync(join(executorRoot, "supervisor.pid"), "4103\n");
    writeFileSync(join(executorRoot, "trend.pid"), "4104\n");
    writeFileSync(join(executorRoot, "sideway.pid"), "4105\n");
    writeFileSync(join(executorRoot, "telegram-mode.pid"), "4106\n");
    writeFileSync(join(executorRoot, "regime-notifier.pid"), "4107\n");
    writeFileSync(join(brokerStateRoot, "heartbeat.json"), JSON.stringify({ version: 1, brokerPid: 4102 }));
    writeFileSync(join(brokerStateRoot, "status.json"), JSON.stringify({ version: 1, brokerPid: 4102 }));

    const launcherHashByPath = new Map(
      components.map(([_component, pid, launcher]) => [
        join(scriptsRoot, launcher),
        `sha256:${String(pid % 10).repeat(64)}`,
      ]),
    );

    const snapshot = getPhase7CRuntimeSourceAttestationSnapshot({
      runtimeRoot,
      projectRoot,
      apiPid: 4101,
      now: () => deployment.createdAt + 99_999,
      readUtf8: (file) => readFileSync(file, "utf8"),
      sha256File: (file) => launcherHashByPath.get(file) ?? (() => { throw new Error(`unexpected hash path ${file}`); })(),
      isPidAlive: (pid) => components.some(([, expectedPid]) => expectedPid === pid),
    });

    assert.equal(snapshot.overall, "EXACT_MATCH");
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.components.length, 8);
    assert.deepEqual(snapshot.components.map((item) => item.component), components.map(([name]) => name));
    assert.ok(snapshot.components.every((item) => item.verdict === "EXACT_MATCH"));
    assert.deepEqual(snapshot.safety, {
      readOnly: true,
      modeMutation: false,
      armMutation: false,
      autoGate: false,
      lifecycleGate: false,
      orderMutation: false,
      positionMutation: false,
      strategyMutation: false,
      autoRetune: false,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});