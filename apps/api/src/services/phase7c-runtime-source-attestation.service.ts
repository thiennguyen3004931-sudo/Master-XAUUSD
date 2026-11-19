import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Phase7CRuntimeSourceComponentName =
  | "api"
  | "web"
  | "lifecycle-broker"
  | "supervisor"
  | "trend"
  | "sideway"
  | "telegram"
  | "regime-notifier";

export type Phase7CRuntimeSourceVerdict =
  | "EXACT_MATCH"
  | "MISMATCH"
  | "STALE"
  | "UNKNOWN";

export interface Phase7CRuntimeSourceConfigIdentity {
  version: 1;
  accountMode: "DEMO" | "LIVE";
  liveExecutionEnabled: boolean;
  runtimeRoot: string;
  controlApiUrl: string;
}

export interface Phase7CRuntimeSourceDeploymentManifest {
  version: 1;
  deploymentId: string;
  sourceCommit: string;
  sourceTree: string;
  branch: "main";
  worktreeClean: true;
  createdAt: number;
  configFingerprint: string;
}

export interface Phase7CRuntimeSourceComponentAttestation {
  version: 1;
  component: Phase7CRuntimeSourceComponentName;
  deploymentId: string;
  sourceCommit: string;
  sourceTree: string;
  pid: number;
  startedAt: number;
  launcherSha256: string;
  configFingerprint: string;
}

export interface Phase7CRuntimeSourceComponentEvaluationInput {
  component: Phase7CRuntimeSourceComponentName;
  deployment: Phase7CRuntimeSourceDeploymentManifest | null;
  attestation: Phase7CRuntimeSourceComponentAttestation | null;
  currentPid: number | null;
  currentPidAlive: boolean | null;
  attestedPidAlive: boolean | null;
  expectedLauncherSha256: string | null;
  evidenceErrors: string[];
}

export interface Phase7CRuntimeSourceComponentResult {
  component: Phase7CRuntimeSourceComponentName;
  verdict: Phase7CRuntimeSourceVerdict;
  pid: number | null;
  alive: boolean | null;
  sourceCommit: string | null;
  deploymentId: string | null;
  reasonCodes: string[];
}

export interface Phase7CRuntimeSourceAttestationSnapshot {
  version: 1;
  source: "PHASE7C_RUNTIME_SOURCE_ATTESTATION";
  generatedAt: number;
  readOnly: true;
  deployment: Phase7CRuntimeSourceDeploymentManifest | null;
  overall: Phase7CRuntimeSourceVerdict;
  components: Phase7CRuntimeSourceComponentResult[];
  safety: {
    readOnly: true;
    modeMutation: false;
    armMutation: false;
    autoGate: false;
    lifecycleGate: false;
    orderMutation: false;
    positionMutation: false;
    strategyMutation: false;
    autoRetune: false;
  };
}

export interface Phase7CRuntimeSourceAttestationDeps {
  runtimeRoot: string;
  projectRoot: string;
  apiPid: number;
  now: () => number;
  readUtf8: (file: string) => string;
  sha256File: (file: string) => string;
  isPidAlive: (pid: number) => boolean;
}

const componentDefinitions: readonly {
  component: Phase7CRuntimeSourceComponentName;
  launcher: string;
  pidFile?: string;
}[] = [
  { component: "api", launcher: "run-phase7b-api-runtime-local.ps1" },
  { component: "web", launcher: "run-phase7b-web-autostart.ps1" },
  { component: "lifecycle-broker", launcher: "run-phase7c-executor-task-runner-local.ps1" },
  { component: "supervisor", launcher: "run-phase7c-executors-local.ps1", pidFile: "supervisor.pid" },
  { component: "trend", launcher: "run-phase7c-trend-controller-local.ps1", pidFile: "trend.pid" },
  { component: "sideway", launcher: "run-phase7c-sideway-controller-local.ps1", pidFile: "sideway.pid" },
  { component: "telegram", launcher: "run-phase7c-telegram-mode-controller-local.ps1", pidFile: "telegram-mode.pid" },
  { component: "regime-notifier", launcher: "run-phase7c-regime-notifier-local.ps1", pidFile: "regime-notifier.pid" },
];

function normalizedConfig(input: Phase7CRuntimeSourceConfigIdentity): Phase7CRuntimeSourceConfigIdentity {
  const accountMode = input.accountMode.trim().toUpperCase();
  if (accountMode !== "DEMO" && accountMode !== "LIVE") {
    throw new Error(`Unsupported Phase7C account mode: ${input.accountMode}`);
  }
  const runtimeRoot = input.runtimeRoot.trim();
  const controlApiUrl = input.controlApiUrl.trim().replace(/\/+$/, "");
  if (!runtimeRoot) throw new Error("runtimeRoot is required for runtime source attestation");
  if (!controlApiUrl) throw new Error("controlApiUrl is required for runtime source attestation");
  return {
    version: 1,
    accountMode,
    liveExecutionEnabled: Boolean(input.liveExecutionEnabled),
    runtimeRoot,
    controlApiUrl,
  };
}

export function canonicalizePhase7CRuntimeSourceConfig(
  input: Phase7CRuntimeSourceConfigIdentity,
): string {
  return JSON.stringify(normalizedConfig(input));
}

export function fingerprintPhase7CRuntimeSourceConfig(
  input: Phase7CRuntimeSourceConfigIdentity,
): string {
  const digest = createHash("sha256")
    .update(canonicalizePhase7CRuntimeSourceConfig(input), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function componentResult(
  input: Phase7CRuntimeSourceComponentEvaluationInput,
  verdict: Phase7CRuntimeSourceVerdict,
  reasonCodes: string[],
): Phase7CRuntimeSourceComponentResult {
  return {
    component: input.component,
    verdict,
    pid: input.currentPid ?? input.attestation?.pid ?? null,
    alive: input.currentPidAlive ?? input.attestedPidAlive ?? null,
    sourceCommit: input.attestation?.sourceCommit ?? null,
    deploymentId: input.attestation?.deploymentId ?? null,
    reasonCodes,
  };
}

export function evaluatePhase7CRuntimeSourceComponent(
  input: Phase7CRuntimeSourceComponentEvaluationInput,
): Phase7CRuntimeSourceComponentResult {
  if (!input.deployment || !input.attestation) {
    return componentResult(input, "UNKNOWN", ["EVIDENCE_MISSING"]);
  }

  const inactiveEvidenceErrors = input.evidenceErrors.filter(
    (code) => code !== "CURRENT_PID_MISSING",
  );
  const noLiveCurrentProcess =
    input.currentPidAlive === false ||
    (input.currentPid === null && input.currentPidAlive !== true);
  if (
    noLiveCurrentProcess &&
    input.attestedPidAlive === false &&
    inactiveEvidenceErrors.length === 0
  ) {
    return componentResult(
      input,
      "STALE",
      input.currentPid === null
        ? ["CURRENT_PID_MISSING", "ATTESTED_PID_DEAD"]
        : ["ATTESTED_PID_DEAD"],
    );
  }

  const mismatchReasons: string[] = [];
  if (input.attestation.component !== input.component) {
    mismatchReasons.push("COMPONENT_MISMATCH");
  }
  if (input.attestation.sourceCommit !== input.deployment.sourceCommit) {
    mismatchReasons.push("SOURCE_COMMIT_MISMATCH");
  }
  if (input.attestation.sourceTree !== input.deployment.sourceTree) {
    mismatchReasons.push("SOURCE_TREE_MISMATCH");
  }
  if (input.attestation.deploymentId !== input.deployment.deploymentId) {
    mismatchReasons.push("DEPLOYMENT_ID_MISMATCH");
  }
  if (input.attestation.configFingerprint !== input.deployment.configFingerprint) {
    mismatchReasons.push("CONFIG_FINGERPRINT_MISMATCH");
  }
  if (
    input.expectedLauncherSha256 !== null &&
    input.attestation.launcherSha256 !== input.expectedLauncherSha256
  ) {
    mismatchReasons.push("LAUNCHER_HASH_MISMATCH");
  }
  if (
    input.currentPid !== null &&
    input.currentPidAlive === true &&
    input.currentPid !== input.attestation.pid
  ) {
    mismatchReasons.push("PID_MISMATCH");
  }
  if (mismatchReasons.length > 0) {
    return componentResult(input, "MISMATCH", mismatchReasons);
  }

  if (input.evidenceErrors.length > 0) {
    return componentResult(input, "UNKNOWN", ["EVIDENCE_INVALID", ...input.evidenceErrors]);
  }
  if (input.expectedLauncherSha256 === null) {
    return componentResult(input, "UNKNOWN", ["EVIDENCE_MISSING"]);
  }

  if (input.currentPid === null) {
    if (input.attestedPidAlive === false) {
      return componentResult(input, "STALE", ["CURRENT_PID_MISSING", "ATTESTED_PID_DEAD"]);
    }
    return componentResult(input, "UNKNOWN", ["CURRENT_PID_MISSING"]);
  }

  if (input.currentPid !== input.attestation.pid) {
    if (input.currentPidAlive === true) {
      return componentResult(input, "MISMATCH", ["PID_MISMATCH"]);
    }
    if (input.attestedPidAlive === false) {
      return componentResult(input, "STALE", ["ATTESTED_PID_DEAD"]);
    }
    return componentResult(input, "UNKNOWN", ["EVIDENCE_INVALID"]);
  }

  if (input.currentPidAlive === false || input.attestedPidAlive === false) {
    return componentResult(input, "STALE", ["ATTESTED_PID_DEAD"]);
  }
  if (input.currentPidAlive !== true || input.attestedPidAlive !== true) {
    return componentResult(input, "UNKNOWN", ["EVIDENCE_MISSING"]);
  }

  return componentResult(input, "EXACT_MATCH", [
    "DEPLOYMENT_MATCH",
    "PID_MATCH",
    "PROCESS_ALIVE",
    "LAUNCHER_HASH_MATCH",
  ]);
}

export function combinePhase7CRuntimeSourceVerdicts(
  values: readonly Phase7CRuntimeSourceVerdict[],
): Phase7CRuntimeSourceVerdict {
  if (values.includes("MISMATCH")) return "MISMATCH";
  if (values.includes("UNKNOWN")) return "UNKNOWN";
  if (values.includes("STALE")) return "STALE";
  return values.length > 0 ? "EXACT_MATCH" : "UNKNOWN";
}

function sha256File(file: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "").trim().toUpperCase()
      : "";
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function defaultRuntimeRoot(): string {
  const explicitRuntimeRoot = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (explicitRuntimeRoot) return resolve(explicitRuntimeRoot);
  const attestationRoot = process.env.PHASE7C_SOURCE_ATTESTATION_ROOT?.trim();
  if (attestationRoot) return dirname(resolve(attestationRoot));
  return resolve(process.cwd(), ".runtime");
}

function defaultProjectRoot(): string {
  const apiLauncher = process.env.PHASE7C_SOURCE_ATTESTATION_API_LAUNCHER?.trim();
  if (apiLauncher) return dirname(dirname(resolve(apiLauncher)));
  return resolve(process.cwd());
}

function resolveDeps(overrides: Partial<Phase7CRuntimeSourceAttestationDeps> = {}): Phase7CRuntimeSourceAttestationDeps {
  return {
    runtimeRoot: overrides.runtimeRoot ?? defaultRuntimeRoot(),
    projectRoot: overrides.projectRoot ?? defaultProjectRoot(),
    apiPid: overrides.apiPid ?? process.pid,
    now: overrides.now ?? (() => Date.now()),
    readUtf8: overrides.readUtf8 ?? ((file) => readFileSync(file, "utf8")),
    sha256File: overrides.sha256File ?? sha256File,
    isPidAlive: overrides.isPidAlive ?? isPidAlive,
  };
}

function isDeploymentManifest(value: unknown): value is Phase7CRuntimeSourceDeploymentManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1
    && typeof item.deploymentId === "string" && /^[0-9a-f]{32}$/.test(item.deploymentId)
    && typeof item.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(item.sourceCommit)
    && typeof item.sourceTree === "string" && /^[0-9a-f]{40}$/.test(item.sourceTree)
    && item.branch === "main"
    && item.worktreeClean === true
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && item.createdAt > 0
    && typeof item.configFingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(item.configFingerprint);
}

function isComponentAttestation(value: unknown): value is Phase7CRuntimeSourceComponentAttestation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.version === 1
    && componentDefinitions.some(({ component }) => component === item.component)
    && typeof item.deploymentId === "string" && /^[0-9a-f]{32}$/.test(item.deploymentId)
    && typeof item.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(item.sourceCommit)
    && typeof item.sourceTree === "string" && /^[0-9a-f]{40}$/.test(item.sourceTree)
    && typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0
    && typeof item.startedAt === "number" && Number.isFinite(item.startedAt) && item.startedAt > 0
    && typeof item.launcherSha256 === "string" && /^sha256:[0-9a-f]{64}$/.test(item.launcherSha256)
    && typeof item.configFingerprint === "string" && /^sha256:[0-9a-f]{64}$/.test(item.configFingerprint);
}

function readJson(
  deps: Phase7CRuntimeSourceAttestationDeps,
  file: string,
): { value: unknown | null; error: string | null } {
  try {
    return { value: JSON.parse(deps.readUtf8(file)), error: null };
  } catch {
    return { value: null, error: "EVIDENCE_READ_ERROR" };
  }
}

function readPidFile(
  deps: Phase7CRuntimeSourceAttestationDeps,
  file: string,
): { pid: number | null; errors: string[] } {
  try {
    const raw = deps.readUtf8(file).trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return { pid: null, errors: ["CURRENT_PID_INVALID"] };
    return { pid, errors: [] };
  } catch {
    return { pid: null, errors: ["CURRENT_PID_MISSING"] };
  }
}

function readBrokerPid(
  deps: Phase7CRuntimeSourceAttestationDeps,
): { pid: number | null; errors: string[] } {
  const stateRoot = join(deps.runtimeRoot, "phase7c-lifecycle-broker", "state");
  const heartbeat = readJson(deps, join(stateRoot, "heartbeat.json"));
  const status = readJson(deps, join(stateRoot, "status.json"));
  if (heartbeat.error || status.error) {
    return { pid: null, errors: ["BROKER_PID_EVIDENCE_MISSING"] };
  }
  const heartbeatPid = Number((heartbeat.value as Record<string, unknown>)?.brokerPid);
  const statusPid = Number((status.value as Record<string, unknown>)?.brokerPid);
  if (!Number.isInteger(heartbeatPid) || heartbeatPid <= 0 || !Number.isInteger(statusPid) || statusPid <= 0) {
    return { pid: null, errors: ["BROKER_PID_EVIDENCE_INVALID"] };
  }
  if (heartbeatPid !== statusPid) {
    return { pid: null, errors: ["BROKER_PID_EVIDENCE_MISMATCH"] };
  }
  return { pid: heartbeatPid, errors: [] };
}

function safeAlive(
  deps: Phase7CRuntimeSourceAttestationDeps,
  pid: number | null,
  errors: string[],
): boolean | null {
  if (pid === null) return null;
  try {
    return deps.isPidAlive(pid);
  } catch {
    errors.push("PID_LIVENESS_UNAVAILABLE");
    return null;
  }
}

function expectedLauncherHash(
  deps: Phase7CRuntimeSourceAttestationDeps,
  launcher: string,
  errors: string[],
): string | null {
  try {
    const value = deps.sha256File(join(deps.projectRoot, "scripts", launcher));
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      errors.push("LAUNCHER_HASH_INVALID");
      return null;
    }
    return value;
  } catch {
    errors.push("LAUNCHER_HASH_UNAVAILABLE");
    return null;
  }
}

export function getPhase7CRuntimeSourceAttestationSnapshot(
  overrides: Partial<Phase7CRuntimeSourceAttestationDeps> = {},
): Phase7CRuntimeSourceAttestationSnapshot {
  const deps = resolveDeps(overrides);
  const attestationRoot = join(deps.runtimeRoot, "phase7c-source-attestation");
  const manifestRead = readJson(deps, join(attestationRoot, "deployment.json"));
  const deployment = isDeploymentManifest(manifestRead.value) ? manifestRead.value : null;

  const components = componentDefinitions.map(({ component, launcher, pidFile }) => {
    const errors: string[] = [];
    if (manifestRead.error || (manifestRead.value !== null && deployment === null)) {
      errors.push("DEPLOYMENT_EVIDENCE_INVALID");
    }

    const componentRead = readJson(deps, join(attestationRoot, "components", `${component}.json`));
    const attestation = isComponentAttestation(componentRead.value) ? componentRead.value : null;
    if (componentRead.error || (componentRead.value !== null && attestation === null)) {
      errors.push("COMPONENT_EVIDENCE_INVALID");
    }

    let currentPid: number | null;
    if (component === "api") {
      currentPid = deps.apiPid;
    } else if (component === "web") {
      const current = readPidFile(deps, join(attestationRoot, "web.pid"));
      currentPid = current.pid;
      errors.push(...current.errors);
    } else if (component === "lifecycle-broker") {
      const brokerPid = readBrokerPid(deps);
      currentPid = brokerPid.pid;
      errors.push(...brokerPid.errors);
    } else {
      const current = readPidFile(deps, join(deps.runtimeRoot, "phase7c-executors", pidFile!));
      currentPid = current.pid;
      errors.push(...current.errors);
    }

    const currentPidAlive = safeAlive(deps, currentPid, errors);
    const attestedPidAlive = safeAlive(deps, attestation?.pid ?? null, errors);
    const expectedLauncherSha256 = expectedLauncherHash(deps, launcher, errors);

    return evaluatePhase7CRuntimeSourceComponent({
      component,
      deployment,
      attestation,
      currentPid,
      currentPidAlive,
      attestedPidAlive,
      expectedLauncherSha256,
      evidenceErrors: errors,
    });
  });

  return {
    version: 1,
    source: "PHASE7C_RUNTIME_SOURCE_ATTESTATION",
    generatedAt: deps.now(),
    readOnly: true,
    deployment,
    overall: combinePhase7CRuntimeSourceVerdicts(components.map((item) => item.verdict)),
    components,
    safety: {
      readOnly: true,
      modeMutation: false,
      armMutation: false,
      autoGate: false,
      lifecycleGate: false,
      orderMutation: false,
      positionMutation: false,
      strategyMutation: false,
      autoRetune: false,
    },
  };
}

function writeAtomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = join(dirname(file), `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(tempFile, "wx");
    writeSync(descriptor, Buffer.from(JSON.stringify(value), "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(tempFile, file);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(tempFile, { force: true });
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for API runtime source attestation`);
  return value;
}

export function writePhase7CApiRuntimeSourceAttestation(): Phase7CRuntimeSourceComponentAttestation {
  const attestationRoot = resolve(requiredEnv("PHASE7C_SOURCE_ATTESTATION_ROOT"));
  const launcherPath = resolve(requiredEnv("PHASE7C_SOURCE_ATTESTATION_API_LAUNCHER"));
  const accountModeRaw = requiredEnv("PHASE7C_SOURCE_ATTESTATION_ACCOUNT_MODE").toUpperCase();
  if (accountModeRaw !== "DEMO" && accountModeRaw !== "LIVE") {
    throw new Error("PHASE7C_SOURCE_ATTESTATION_ACCOUNT_MODE must be DEMO or LIVE");
  }
  const liveRaw = requiredEnv("PHASE7C_SOURCE_ATTESTATION_LIVE_EXECUTION_ENABLED").toLowerCase();
  if (liveRaw !== "true" && liveRaw !== "false") {
    throw new Error("PHASE7C_SOURCE_ATTESTATION_LIVE_EXECUTION_ENABLED must be true or false");
  }
  const liveExecutionEnabled = liveRaw === "true";
  if ((accountModeRaw === "LIVE") !== liveExecutionEnabled) {
    throw new Error("API source attestation account/live-execution context is inconsistent");
  }
  const controlApiUrl = requiredEnv("PHASE7C_SOURCE_ATTESTATION_CONTROL_API_URL").replace(/\/+$/, "");
  const runtimeRoot = dirname(attestationRoot);

  const manifestValue = JSON.parse(readFileSync(join(attestationRoot, "deployment.json"), "utf8"));
  if (!isDeploymentManifest(manifestValue)) {
    throw new Error("Runtime source deployment manifest is invalid for API attestation");
  }

  const configIdentity: Phase7CRuntimeSourceConfigIdentity = {
    version: 1,
    accountMode: accountModeRaw,
    liveExecutionEnabled,
    runtimeRoot,
    controlApiUrl,
  };
  const record: Phase7CRuntimeSourceComponentAttestation = {
    version: 1,
    component: "api",
    deploymentId: manifestValue.deploymentId,
    sourceCommit: manifestValue.sourceCommit,
    sourceTree: manifestValue.sourceTree,
    pid: process.pid,
    startedAt: Date.now(),
    launcherSha256: sha256File(launcherPath),
    configFingerprint: fingerprintPhase7CRuntimeSourceConfig(configIdentity),
  };
  writeAtomicJson(join(attestationRoot, "components", "api.json"), record);
  return record;
}