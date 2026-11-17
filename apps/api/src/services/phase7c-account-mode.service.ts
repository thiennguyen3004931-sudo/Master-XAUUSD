import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type Phase7CAccountMode = "DEMO" | "LIVE";

export type Phase7CAccountModeState = {
  version: 1;
  accountMode: Phase7CAccountMode;
  liveExecutionEnabled: boolean;
  envFile: string | null;
  updatedAt: string | null;
  updatedBy: string;
  valid: boolean;
  source: "RUNTIME_STATE" | "LEGACY_DEMO_DEFAULT" | "INVALID_FAIL_CLOSED";
  error: string | null;
};

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return resolve(demoDir, "..");
  return resolve(process.cwd(), ".runtime");
}

export function phase7CAccountModeStatePath(): string {
  return resolve(runtimeRoot(), "phase7c-account-mode.json");
}

function legacyDemoDefault(): Phase7CAccountModeState {
  return {
    version: 1,
    accountMode: "DEMO",
    liveExecutionEnabled: false,
    envFile: null,
    updatedAt: null,
    updatedBy: "legacy-demo-default",
    valid: true,
    source: "LEGACY_DEMO_DEFAULT",
    error: null,
  };
}

export function getPhase7CAccountModeState(): Phase7CAccountModeState {
  const path = phase7CAccountModeStatePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") return legacyDemoDefault();
    return {
      ...legacyDemoDefault(),
      valid: false,
      source: "INVALID_FAIL_CLOSED",
      updatedBy: "account-mode-read-error",
      error: error instanceof Error ? error.message : "Could not read account mode state.",
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Number(parsed.version) !== 1) throw new Error("version must be 1");
    const accountMode = String(parsed.accountMode ?? "").trim().toUpperCase();
    if (accountMode !== "DEMO" && accountMode !== "LIVE") {
      throw new Error(`unsupported accountMode=${accountMode || "missing"}`);
    }
    const liveExecutionEnabled = parsed.liveExecutionEnabled === true;
    if (accountMode === "DEMO" && liveExecutionEnabled) {
      throw new Error("DEMO cannot set liveExecutionEnabled=true");
    }
    if (accountMode === "LIVE" && !liveExecutionEnabled) {
      throw new Error("LIVE requires liveExecutionEnabled=true");
    }
    return {
      version: 1,
      accountMode,
      liveExecutionEnabled,
      envFile: typeof parsed.envFile === "string" && parsed.envFile.trim() ? parsed.envFile.trim() : null,
      updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : null,
      updatedBy: typeof parsed.updatedBy === "string" && parsed.updatedBy.trim() ? parsed.updatedBy.trim() : "account-switch",
      valid: true,
      source: "RUNTIME_STATE",
      error: null,
    };
  } catch (error) {
    return {
      ...legacyDemoDefault(),
      valid: false,
      source: "INVALID_FAIL_CLOSED",
      updatedBy: "account-mode-parse-error",
      error: error instanceof Error ? error.message : "Invalid account mode state.",
    };
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

export function setPhase7CAccountModeFromWebAutoDetection(input: {
  accountMode: Phase7CAccountMode;
  envFile: string;
  liveAuthorizationValidated: boolean;
  updatedBy?: string;
}): Phase7CAccountModeState {
  if (!input.envFile.trim()) throw new Error("Selected account envFile is required.");
  if (input.accountMode === "LIVE" && input.liveAuthorizationValidated !== true) {
    throw new Error("Web cannot select LIVE without validated prior LIVE authorization.");
  }
  if (input.accountMode === "DEMO" && input.liveAuthorizationValidated === true) {
    throw new Error("DEMO selection cannot carry LIVE authorization into execution state.");
  }

  writeJsonAtomic(phase7CAccountModeStatePath(), {
    version: 1,
    accountMode: input.accountMode,
    liveExecutionEnabled: input.accountMode === "LIVE",
    envFile: resolve(input.envFile),
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy?.trim() || "web-auto-detect-account",
  });
  return getPhase7CAccountModeState();
}

export function expectedBrokerAccountMode(state = getPhase7CAccountModeState()): "demo" | "real" {
  return state.accountMode === "LIVE" ? "real" : "demo";
}

export function accountModeAllowsBroker(
  brokerMode: string | null | undefined,
  state = getPhase7CAccountModeState(),
): boolean {
  if (!state.valid) return false;
  if (state.accountMode === "LIVE" && !state.liveExecutionEnabled) return false;
  return String(brokerMode ?? "").toLowerCase() === expectedBrokerAccountMode(state);
}
