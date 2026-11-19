import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getPhase7CAccountModeState } from "./phase7c-account-mode.service.js";

export interface Phase7CLiveProfileIdentity {
  accountLogin: number;
  server: string;
  terminalPath: string;
  profileFingerprint: string;
}

export interface Phase7CLiveAuthorizationRecord {
  version: 1;
  authorized: true;
  accountMode: "LIVE";
  accountLogin: number;
  server: string;
  profileFingerprint: string;
  authorizedAt: string;
  authorizedBy: string;
}

export type Phase7CLiveAuthorizationReason =
  | "LIVE_AUTHORIZED"
  | "LIVE_AUTH_MISSING"
  | "LIVE_AUTH_INVALID_RECORD"
  | "LIVE_AUTH_PROFILE_MISMATCH"
  | "LIVE_AUTH_LOGIN_MISMATCH"
  | "LIVE_AUTH_SERVER_MISMATCH"
  | "LIVE_AUTH_BROKER_LOGIN_MISSING"
  | "LIVE_AUTH_BROKER_LOGIN_MISMATCH"
  | "LIVE_AUTH_BROKER_SERVER_MISSING"
  | "LIVE_AUTH_BROKER_SERVER_MISMATCH"
  | "LIVE_AUTH_PROFILE_INVALID";

export interface Phase7CLiveAuthorizationEvaluation {
  valid: boolean;
  reason: Phase7CLiveAuthorizationReason;
}

export interface Phase7CLiveAuthorizationStatus
  extends Phase7CLiveAuthorizationEvaluation {
  source: "DURABLE" | "LEGACY_EXPLICIT_LIVE_STATE_MIGRATED" | "NONE";
  authorization: Phase7CLiveAuthorizationRecord | null;
  identity: Phase7CLiveProfileIdentity | null;
  error: string | null;
}

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return resolve(demoDir, "..");
  return resolve(process.cwd(), ".runtime");
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let index = 0; index < 8; index += 1) {
    try {
      readFileSync(resolve(current, "pnpm-workspace.yaml"), "utf8");
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return process.cwd();
}

function normalizeServer(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeTerminalPath(value: string): string {
  return value.trim().replaceAll("/", "\\").toLowerCase();
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^\uFEFF/, "");
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function isTruthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function configuredLiveEnvFile(): string {
  const state = getPhase7CAccountModeState();
  if (state.valid && state.accountMode === "LIVE" && state.envFile) {
    return resolve(state.envFile);
  }
  return resolve(
    findProjectRoot(),
    "packages",
    "mt5-broker",
    "bridge",
    ".env.phase7b-live",
  );
}

export function phase7CLiveAuthorizationPath(): string {
  return resolve(runtimeRoot(), "phase7c-live-authorization.json");
}

export function getPhase7CLiveProfileIdentity(
  liveEnvFile = configuredLiveEnvFile(),
): Phase7CLiveProfileIdentity {
  const env = parseEnvFile(liveEnvFile);
  if (!isTruthy(env.MT5_ALLOW_REAL_ACCOUNT)) {
    throw new Error("LIVE env requires MT5_ALLOW_REAL_ACCOUNT=true.");
  }
  if (!isTruthy(env.MT5_TRADING_ENABLED)) {
    throw new Error("LIVE env requires MT5_TRADING_ENABLED=true.");
  }

  const accountLogin = Number(env.MT5_LOGIN);
  if (!Number.isInteger(accountLogin) || accountLogin <= 0) {
    throw new Error("LIVE MT5_LOGIN must be a positive account number.");
  }
  const server = String(env.MT5_SERVER ?? "").trim();
  if (!server) throw new Error("LIVE MT5_SERVER is required.");
  const terminalPath = String(env.MT5_TERMINAL_PATH ?? "").trim();
  if (!terminalPath) throw new Error("LIVE MT5_TERMINAL_PATH is required.");

  const allowedLogins = String(env.MT5_ALLOWED_LOGINS ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (!allowedLogins.includes(accountLogin)) {
    throw new Error("LIVE MT5_LOGIN must be present in MT5_ALLOWED_LOGINS.");
  }

  const payload = `LIVE|${accountLogin}|${server.toLowerCase()}|${normalizeTerminalPath(terminalPath)}`;
  const profileFingerprint = createHash("sha256").update(payload, "utf8").digest("hex");
  return { accountLogin, server, terminalPath, profileFingerprint };
}

function parseAuthorization(value: unknown): Phase7CLiveAuthorizationRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Phase7CLiveAuthorizationRecord>;
  if (
    Number(raw.version) !== 1 ||
    raw.authorized !== true ||
    raw.accountMode !== "LIVE" ||
    !Number.isInteger(Number(raw.accountLogin)) ||
    Number(raw.accountLogin) <= 0 ||
    typeof raw.server !== "string" ||
    !raw.server.trim() ||
    typeof raw.profileFingerprint !== "string" ||
    !/^[a-f0-9]{16,128}$/i.test(raw.profileFingerprint.trim()) ||
    typeof raw.authorizedAt !== "string" ||
    !raw.authorizedAt.trim() ||
    typeof raw.authorizedBy !== "string" ||
    !raw.authorizedBy.trim()
  ) {
    return null;
  }
  return {
    version: 1,
    authorized: true,
    accountMode: "LIVE",
    accountLogin: Number(raw.accountLogin),
    server: raw.server.trim(),
    profileFingerprint: raw.profileFingerprint.trim().toLowerCase(),
    authorizedAt: raw.authorizedAt.trim(),
    authorizedBy: raw.authorizedBy.trim(),
  };
}

export function evaluatePhase7CLiveAuthorization(input: {
  authorization: Phase7CLiveAuthorizationRecord | null;
  expectedIdentity: Phase7CLiveProfileIdentity;
  brokerAccountLogin: number | null | undefined;
  brokerServer: string | null | undefined;
}): Phase7CLiveAuthorizationEvaluation {
  const { authorization, expectedIdentity } = input;
  if (!authorization) return { valid: false, reason: "LIVE_AUTH_MISSING" };
  if (
    authorization.version !== 1 ||
    authorization.authorized !== true ||
    authorization.accountMode !== "LIVE"
  ) {
    return { valid: false, reason: "LIVE_AUTH_INVALID_RECORD" };
  }
  if (authorization.accountLogin !== expectedIdentity.accountLogin) {
    return { valid: false, reason: "LIVE_AUTH_LOGIN_MISMATCH" };
  }
  if (normalizeServer(authorization.server) !== normalizeServer(expectedIdentity.server)) {
    return { valid: false, reason: "LIVE_AUTH_SERVER_MISMATCH" };
  }
  if (
    authorization.profileFingerprint.trim().toLowerCase() !==
    expectedIdentity.profileFingerprint.trim().toLowerCase()
  ) {
    return { valid: false, reason: "LIVE_AUTH_PROFILE_MISMATCH" };
  }

  const brokerAccountLogin = Number(input.brokerAccountLogin);
  if (!Number.isInteger(brokerAccountLogin) || brokerAccountLogin <= 0) {
    return { valid: false, reason: "LIVE_AUTH_BROKER_LOGIN_MISSING" };
  }
  if (brokerAccountLogin !== expectedIdentity.accountLogin) {
    return { valid: false, reason: "LIVE_AUTH_BROKER_LOGIN_MISMATCH" };
  }
  if (!normalizeServer(input.brokerServer)) {
    return { valid: false, reason: "LIVE_AUTH_BROKER_SERVER_MISSING" };
  }
  if (normalizeServer(input.brokerServer) !== normalizeServer(expectedIdentity.server)) {
    return { valid: false, reason: "LIVE_AUTH_BROKER_SERVER_MISMATCH" };
  }
  return { valid: true, reason: "LIVE_AUTHORIZED" };
}

function writeAuthorizationAtomic(record: Phase7CLiveAuthorizationRecord): void {
  const filePath = phase7CLiveAuthorizationPath();
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

function readDurableAuthorization(): {
  exists: boolean;
  authorization: Phase7CLiveAuthorizationRecord | null;
} {
  try {
    const parsed = JSON.parse(readFileSync(phase7CLiveAuthorizationPath(), "utf8"));
    return { exists: true, authorization: parseAuthorization(parsed) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (code === "ENOENT") return { exists: false, authorization: null };
    return { exists: true, authorization: null };
  }
}

export function getPhase7CLiveAuthorizationStatus(
  brokerServer: string | null | undefined,
  brokerAccountLogin: number | null | undefined,
): Phase7CLiveAuthorizationStatus {
  let identity: Phase7CLiveProfileIdentity;
  try {
    identity = getPhase7CLiveProfileIdentity();
  } catch (error) {
    return {
      valid: false,
      reason: "LIVE_AUTH_PROFILE_INVALID",
      source: "NONE",
      authorization: null,
      identity: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const durable = readDurableAuthorization();
  if (durable.exists && !durable.authorization) {
    return {
      valid: false,
      reason: "LIVE_AUTH_INVALID_RECORD",
      source: "NONE",
      authorization: null,
      identity,
      error: "Durable LIVE authorization file is invalid; refusing migration or LIVE start.",
    };
  }
  const evaluation = evaluatePhase7CLiveAuthorization({
    authorization: durable.authorization,
    expectedIdentity: identity,
    brokerAccountLogin,
    brokerServer,
  });
  return {
    ...evaluation,
    source: evaluation.valid ? "DURABLE" : "NONE",
    authorization: durable.authorization,
    identity,
    error: null,
  };
}

function legacyAuthorizationRecord(): Phase7CLiveAuthorizationRecord | null {
  const accountState = getPhase7CAccountModeState();
  if (
    !accountState.valid ||
    accountState.accountMode !== "LIVE" ||
    accountState.liveExecutionEnabled !== true
  ) {
    return null;
  }
  const identity = getPhase7CLiveProfileIdentity();
  return {
    version: 1,
    authorized: true,
    accountMode: "LIVE",
    accountLogin: identity.accountLogin,
    server: identity.server,
    profileFingerprint: identity.profileFingerprint,
    authorizedAt: accountState.updatedAt ?? new Date().toISOString(),
    authorizedBy: `legacy-explicit-live-state:${accountState.updatedBy}`,
  };
}

export function preserveLegacyExplicitLiveAuthorization(): boolean {
  const filePath = phase7CLiveAuthorizationPath();
  if (existsSync(filePath)) return false;
  const record = legacyAuthorizationRecord();
  if (!record) return false;
  writeAuthorizationAtomic(record);
  return true;
}

export function ensurePhase7CLiveAuthorizationForWebStart(
  brokerServer: string | null | undefined,
  brokerAccountLogin: number | null | undefined,
): Phase7CLiveAuthorizationStatus {
  const existing = getPhase7CLiveAuthorizationStatus(brokerServer, brokerAccountLogin);
  if (existing.valid || existing.reason !== "LIVE_AUTH_MISSING") return existing;

  const record = legacyAuthorizationRecord();
  if (!record || !existing.identity) return existing;
  const evaluation = evaluatePhase7CLiveAuthorization({
    authorization: record,
    expectedIdentity: existing.identity,
    brokerAccountLogin,
    brokerServer,
  });
  if (!evaluation.valid) {
    return {
      ...existing,
      reason: evaluation.reason,
    };
  }

  writeAuthorizationAtomic(record);
  return {
    valid: true,
    reason: "LIVE_AUTHORIZED",
    source: "LEGACY_EXPLICIT_LIVE_STATE_MIGRATED",
    authorization: record,
    identity: existing.identity,
    error: null,
  };
}