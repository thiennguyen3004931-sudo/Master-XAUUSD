import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { accountModeAllowsBroker, getPhase7CAccountModeState } from "./phase7c-account-mode.service";
import { getPhase7CLifecycleRuntimeStatus } from "./phase7c-lifecycle.service";
import { getPhase7CLiveAuthorizationStatus } from "./phase7c-live-authorization.service";
import { getMt5Telemetry } from "./mt5.service";

const execFileAsync = promisify(execFile);
const TASK_NAME = "XAUUSD-Phase7C-Live-Arm-Control";
const PREFLIGHT_TTL_MS = 45_000;
const REQUEST_RUNNING_STALE_MS = 10 * 60_000;

export type Phase7CLiveArmAction = "ARM_LIVE" | "DISARM_LIVE";
type ControlStatus = "RUNNING" | "PASS" | "FAIL";

type PreflightToken = {
  token: string;
  action: Phase7CLiveArmAction;
  bridgeSessionId: string | null;
  createdAt: number;
  expiresAt: number;
};

export type Phase7CLiveArmControlStatus = {
  version: 1;
  requestId: string;
  action: Phase7CLiveArmAction;
  status: ControlStatus;
  phase: string;
  message: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  finalArmStatus: string;
};

const preflightTokens = new Map<string, PreflightToken>();

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return path.resolve(demoDir, "..");
  return path.resolve(process.cwd(), ".runtime");
}

function statusPath(): string {
  return path.join(runtimeRoot(), "phase7c-live-arm-control-status.json");
}

function requestPath(): string {
  return path.join(runtimeRoot(), "phase7c-live-arm-control-request.json");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

async function taskInstalled(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    await execFileAsync("schtasks.exe", ["/Query", "/TN", TASK_NAME], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 32 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, item] of preflightTokens.entries()) {
    if (item.expiresAt <= now) preflightTokens.delete(token);
  }
}

function readStatus(): Phase7CLiveArmControlStatus | null {
  return readJson<Phase7CLiveArmControlStatus>(statusPath());
}

async function evaluate(action: Phase7CLiveArmAction) {
  const account = getPhase7CAccountModeState();
  const lifecycle = getPhase7CLifecycleRuntimeStatus();
  const telemetry = await getMt5Telemetry("XAUUSD");
  const liveAuthorization = action === "ARM_LIVE"
    ? getPhase7CLiveAuthorizationStatus(telemetry.health?.server ?? null, telemetry.accountLogin)
    : null;
  const installed = await taskInstalled();
  const armStatus = telemetry.health?.liveArmStatus ?? "DISARMED";
  const armed = telemetry.health?.liveExecutionArmed === true && armStatus === "ARMED";
  const bridgeSessionId = telemetry.health?.bridgeSessionId ?? null;
  const status = readStatus();
  const requestExists = fs.existsSync(requestPath());
  const statusAgeMs = status ? Date.now() - status.updatedAt : null;
  const statusRunning = status?.status === "RUNNING" &&
    statusAgeMs !== null && statusAgeMs <= REQUEST_RUNNING_STALE_MS;
  const noControlRunning = !requestExists && !statusRunning;
  const orphanedControlRequest = requestExists && (
    !status ||
    status.status !== "RUNNING" ||
    statusAgeMs === null ||
    statusAgeMs > REQUEST_RUNNING_STALE_MS
  );

  const commonChecks = {
    taskInstalled: installed,
    accountStateValid: account.valid === true,
    selectedLiveAccount: account.accountMode === "LIVE",
    botPaused: lifecycle.mode.mode === "PAUSE",
    bridgeReachable: telemetry.reachable === true,
    bridgeMatchesSelectedAccount: accountModeAllowsBroker(telemetry.health?.accountMode, account),
    brokerIsReal: telemetry.health?.accountMode === "real",
    noControlRunning,
  };

  const checks = action === "ARM_LIVE"
    ? {
        ...commonChecks,
        liveAuthorizationValid: liveAuthorization?.valid === true,
        runtimeReady: lifecycle.ready === true,
        tradingEnabled: telemetry.health?.tradingEnabled === true,
        terminalTradeAllowed: telemetry.health?.terminalTradeAllowed === true,
        expertTradeAllowed: telemetry.health?.expertTradeAllowed === true,
        zeroXauusdPositions: telemetry.positions.length === 0,
        bridgeSessionAvailable: typeof bridgeSessionId === "string" && bridgeSessionId.trim().length > 0,
        currentlyDisarmed: !armed,
      }
    : {
        taskInstalled: installed,
        accountStateValid: account.valid === true,
        selectedLiveAccount: account.accountMode === "LIVE",
        bridgeReachable: telemetry.reachable === true,
        brokerIsReal: telemetry.health?.accountMode === "real",
        currentlyArmed: armed,
        noControlRunning,
      };

  const blockedBy = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key);

  return {
    approved: blockedBy.length === 0,
    action,
    accountMode: account.accountMode,
    botMode: lifecycle.mode.mode,
    liveArmStatus: armStatus,
    liveExecutionArmed: armed,
    bridgeSessionId,
    openXauusdPositions: telemetry.positions.length,
    taskInstalled: installed,
    orphanedControlRequest: requestExists && orphanedControlRequest,
    checks,
    blockedBy,
  };
}

export async function getPhase7CLiveArmControlCapability() {
  const arm = await evaluate("ARM_LIVE");
  const disarm = await evaluate("DISARM_LIVE");
  return {
    taskInstalled: arm.taskInstalled,
    accountMode: arm.accountMode,
    botMode: arm.botMode,
    liveArmStatus: arm.liveArmStatus,
    liveExecutionArmed: arm.liveExecutionArmed,
    bridgeSessionId: arm.bridgeSessionId,
    openXauusdPositions: arm.openXauusdPositions,
    orphanedControlRequest: arm.orphanedControlRequest || disarm.orphanedControlRequest,
    canArm: arm.approved,
    canDisarm: disarm.approved,
    armChecks: arm.checks,
    armBlockedBy: arm.blockedBy,
    disarmChecks: disarm.checks,
    disarmBlockedBy: disarm.blockedBy,
    safety: {
      localOnly: true as const,
      elevatedTaskName: TASK_NAME,
      canonicalArmScript: "scripts/arm-phase7c-live-local.ps1" as const,
      canonicalDisarmScript: "scripts/disarm-phase7c-live-local.ps1" as const,
      orderSend: false as const,
      autoAfterArm: false as const,
    },
  };
}

export async function createPhase7CLiveArmPreflight(action: Phase7CLiveArmAction) {
  cleanupExpiredTokens();
  const evaluation = await evaluate(action);
  if (!evaluation.approved) return { ...evaluation, preflightToken: null, expiresAt: null };
  const createdAt = Date.now();
  const token = crypto.randomUUID();
  preflightTokens.set(token, {
    token,
    action,
    bridgeSessionId: evaluation.bridgeSessionId,
    createdAt,
    expiresAt: createdAt + PREFLIGHT_TTL_MS,
  });
  return { ...evaluation, preflightToken: token, expiresAt: createdAt + PREFLIGHT_TTL_MS };
}

export async function submitPhase7CLiveArmControl(input: {
  action: Phase7CLiveArmAction;
  preflightToken: string;
  confirmation: string;
}) {
  cleanupExpiredTokens();
  const token = preflightTokens.get(input.preflightToken);
  preflightTokens.delete(input.preflightToken);
  if (!token || token.action !== input.action || token.expiresAt <= Date.now()) {
    throw new Error("Preflight ARM token không hợp lệ hoặc đã hết hạn. Hãy kiểm tra lại điều kiện.");
  }
  if (input.confirmation !== input.action) {
    throw new Error(`Xác nhận không đúng. Expected=${input.action}.`);
  }

  const fresh = await evaluate(input.action);
  if (!fresh.approved) {
    throw new Error(`Điều kiện ARM runtime đã thay đổi: ${fresh.blockedBy.join(", ") || "UNKNOWN"}.`);
  }
  if (input.action === "ARM_LIVE" && fresh.bridgeSessionId !== token.bridgeSessionId) {
    throw new Error("Bridge session đã thay đổi sau preflight; không ARM và yêu cầu kiểm tra lại.");
  }
  if (fs.existsSync(requestPath())) {
    throw new Error("LIVE ARM control request đang tồn tại; không ghi đè yêu cầu chưa xử lý.");
  }

  const requestId = crypto.randomUUID();
  const createdAt = Date.now();
  atomicWriteJson(requestPath(), {
    version: 1,
    requestId,
    action: input.action,
    confirmation: input.action,
    source: "LOCAL_WEB",
    bridgeSessionId: fresh.bridgeSessionId,
    createdAt,
  });
  atomicWriteJson(statusPath(), {
    version: 1,
    requestId,
    action: input.action,
    status: "RUNNING",
    phase: "QUEUED",
    message: "Yêu cầu đã được tạo; đang chờ elevated LIVE ARM task.",
    startedAt: createdAt,
    updatedAt: createdAt,
    completedAt: null,
    finalArmStatus: fresh.liveArmStatus,
  } satisfies Phase7CLiveArmControlStatus);

  try {
    await execFileAsync("schtasks.exe", ["/Run", "/TN", TASK_NAME], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 32 * 1024,
    });
  } catch (error) {
    try { fs.unlinkSync(requestPath()); } catch { /* request may already be consumed */ }
    const now = Date.now();
    const message = error instanceof Error ? error.message : "Không khởi chạy được elevated LIVE ARM task.";
    atomicWriteJson(statusPath(), {
      version: 1,
      requestId,
      action: input.action,
      status: "FAIL",
      phase: "TASK_START_FAILED",
      message,
      startedAt: createdAt,
      updatedAt: now,
      completedAt: now,
      finalArmStatus: fresh.liveArmStatus,
    } satisfies Phase7CLiveArmControlStatus);
    throw new Error("Không khởi chạy được elevated LIVE ARM task. Kiểm tra task registration/quyền Windows.");
  }

  return {
    accepted: true as const,
    requestId,
    action: input.action,
    status: "RUNNING" as const,
    message: "Đã gửi yêu cầu tới elevated LIVE ARM task.",
  };
}

export function getPhase7CLiveArmControlStatus(requestId?: string) {
  const status = readStatus();
  if (!status) return null;
  if (requestId && status.requestId !== requestId) return null;
  return status;
}
