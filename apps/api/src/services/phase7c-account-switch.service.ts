import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getPhase7CAccountModeState, type Phase7CAccountMode } from "./phase7c-account-mode.service";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";
import { getPhase7CLifecycleRuntimeStatus } from "./phase7c-lifecycle.service";
import { getMt5Telemetry } from "./mt5.service";

const execFileAsync = promisify(execFile);
const TASK_NAME = "XAUUSD-Phase7C-Account-Switch";
const PREFLIGHT_TTL_MS = 45_000;
const REQUEST_RUNNING_STALE_MS = 10 * 60_000;

type SwitchTarget = "DEMO" | "LIVE";
type SwitchStatus = "RUNNING" | "PASS" | "FAIL";

type PreflightToken = {
  token: string;
  targetMode: SwitchTarget;
  currentMode: SwitchTarget;
  createdAt: number;
  expiresAt: number;
};

type StrategyState = {
  managed?: { ticket?: string | number | null } | null;
  pendingPullback?: unknown;
  pendingEntry?: unknown;
};

export type Phase7CAccountSwitchStatus = {
  version: 1;
  requestId: string;
  targetMode: SwitchTarget;
  status: SwitchStatus;
  phase: string;
  message: string;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  finalAccountMode: string;
  finalBotMode: string;
  liveArmFilePresent: boolean;
};

const preflightTokens = new Map<string, PreflightToken>();

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return path.resolve(demoDir, "..");
  return path.resolve(process.cwd(), ".runtime");
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

function accountPaths(mode: SwitchTarget) {
  const root = runtimeRoot();
  return mode === "LIVE"
    ? {
        trend: path.join(root, "phase7b-live-forward", "phase7b-demo-state.json"),
        sideway: path.join(root, "phase7c-sideway-live-forward", "phase7c-sideway-state.json"),
      }
    : {
        trend: path.join(root, "phase7b-demo-forward", "phase7b-demo-state.json"),
        sideway: path.join(root, "phase7c-sideway-forward", "phase7c-sideway-state.json"),
      };
}

function hasTicket(state: StrategyState | null): boolean {
  const ticket = state?.managed?.ticket;
  return ticket !== undefined && ticket !== null && String(ticket).trim() !== "";
}

function strategySafety(mode: SwitchTarget) {
  const paths = accountPaths(mode);
  const trend = readJson<StrategyState>(paths.trend);
  const sideway = readJson<StrategyState>(paths.sideway);
  const trendManaged = hasTicket(trend);
  const sidewayManaged = hasTicket(sideway);
  const trendPending = trend?.pendingPullback !== undefined && trend?.pendingPullback !== null;
  const sidewayPending = sideway?.pendingEntry !== undefined && sideway?.pendingEntry !== null;
  const executionLock = fs.existsSync(path.join(runtimeRoot(), "phase7c-executors", "phase7c-execution.lock"));
  return {
    trendManaged,
    sidewayManaged,
    trendPending,
    sidewayPending,
    executionLock,
    flatStrategyState: !trendManaged && !sidewayManaged && !trendPending && !sidewayPending && !executionLock,
  };
}

async function switchTaskInstalled(): Promise<boolean> {
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

function armFilePresent(): boolean {
  return fs.existsSync(path.join(runtimeRoot(), "phase7c-live-arm.json"));
}

function statusPath(): string {
  return path.join(runtimeRoot(), "phase7c-account-switch-status.json");
}

function requestPath(): string {
  return path.join(runtimeRoot(), "phase7c-account-switch-request.json");
}

function readStatus(): Phase7CAccountSwitchStatus | null {
  return readJson<Phase7CAccountSwitchStatus>(statusPath());
}

function noSwitchRunning(): boolean {
  const status = readStatus();
  return !status || status.status !== "RUNNING" || Date.now() - status.updatedAt > REQUEST_RUNNING_STALE_MS;
}

function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, item] of preflightTokens.entries()) {
    if (item.expiresAt <= now) preflightTokens.delete(token);
  }
}

export function isPhase7CAccountSwitchTarget(value: unknown): value is SwitchTarget {
  return value === "DEMO" || value === "LIVE";
}

export async function getPhase7CAccountSwitchCapability() {
  const account = getPhase7CAccountModeState();
  const lifecycle = getPhase7CLifecycleRuntimeStatus();
  return {
    localOnly: true as const,
    elevatedTaskName: TASK_NAME,
    taskInstalled: await switchTaskInstalled(),
    currentAccountMode: account.accountMode,
    currentBotMode: lifecycle.mode.mode,
    liveArmFilePresent: armFilePresent(),
    webCanSwitchAccount: true as const,
    webCanArmLive: false as const,
    policy: {
      explicitPauseRequired: true,
      zeroPositionsRequired: true,
      flatManagedStateRequired: true,
      typedConfirmationRequired: true,
      finalBotMode: "PAUSE" as const,
      finalLiveArmStatus: "DISARMED" as const,
      armAfterLiveSwitch: false as const,
    },
  };
}

export async function getPhase7CSameModeAccountChangeReadiness() {
  const account = getPhase7CAccountModeState();
  const currentMode = account.accountMode as SwitchTarget;
  const lifecycle = getPhase7CLifecycleRuntimeStatus();
  const telemetry = await getMt5Telemetry("XAUUSD");
  const strategy = strategySafety(currentMode);
  const openPositions = telemetry.positions.length;
  const brokerExpected = currentMode === "LIVE" ? "real" : "demo";
  const brokerMatches = telemetry.reachable && telemetry.health?.accountMode === brokerExpected;
  const currentArmFile = armFilePresent();
  const liveDisarmed = currentMode !== "LIVE" || !currentArmFile;

  const checks = {
    accountStateValid: account.valid,
    botPaused: lifecycle.mode.mode === "PAUSE",
    runtimeReady: lifecycle.ready,
    bridgeMatchesSelectedAccount: brokerMatches,
    zeroXauusdPositions: openPositions === 0,
    noTrendManagedTicket: !strategy.trendManaged,
    noSidewayManagedTicket: !strategy.sidewayManaged,
    noTrendPendingPullback: !strategy.trendPending,
    noSidewayPendingEntry: !strategy.sidewayPending,
    noExecutionLock: !strategy.executionLock,
    liveDisarmed,
    noSwitchRunning: noSwitchRunning(),
  };

  return {
    approved: Object.values(checks).every(Boolean),
    currentMode,
    currentBotMode: lifecycle.mode.mode,
    accountLogin: telemetry.accountLogin,
    server: telemetry.health?.server ?? null,
    openXauusdPositions: openPositions,
    liveArmFilePresent: currentArmFile,
    checks,
    note: currentMode === "LIVE"
      ? "Đổi login LIVE cùng loại chỉ được chuẩn bị khi PAUSE + DISARMED + flat. Đăng nhập tài khoản mới trực tiếp trong MT5; Web chỉ xác minh read-only và không tự ARM/AUTO."
      : "Đổi login DEMO cùng loại chỉ được chuẩn bị khi PAUSE + flat. Đăng nhập tài khoản mới trực tiếp trong MT5; Web chỉ xác minh read-only và không tự AUTO.",
  };
}

async function evaluateSwitch(targetMode: SwitchTarget) {
  const account = getPhase7CAccountModeState();
  const currentMode = account.accountMode as SwitchTarget;
  const lifecycle = getPhase7CLifecycleRuntimeStatus();
  const telemetry = await getMt5Telemetry("XAUUSD");
  const strategy = strategySafety(currentMode);
  const taskInstalled = await switchTaskInstalled();
  const openPositions = telemetry.positions.length;
  const brokerExpected = currentMode === "LIVE" ? "real" : "demo";
  const brokerMatches = telemetry.reachable && telemetry.health?.accountMode === brokerExpected;
  const currentArmFile = armFilePresent();
  const notAlreadyTarget = currentMode !== targetMode;
  const pause = lifecycle.mode.mode === "PAUSE";
  const runtimeReady = lifecycle.ready;
  const noOpenPositions = openPositions === 0;
  const demoToLiveArmSafe = !(currentMode === "DEMO" && currentArmFile);

  const checks = {
    taskInstalled,
    accountStateValid: account.valid,
    notAlreadyTarget,
    botPaused: pause,
    runtimeReady,
    bridgeMatchesSelectedAccount: brokerMatches,
    zeroXauusdPositions: noOpenPositions,
    noTrendManagedTicket: !strategy.trendManaged,
    noSidewayManagedTicket: !strategy.sidewayManaged,
    noTrendPendingPullback: !strategy.trendPending,
    noSidewayPendingEntry: !strategy.sidewayPending,
    noExecutionLock: !strategy.executionLock,
    demoToLiveArmSafe,
    noSwitchRunning: noSwitchRunning(),
  };
  const approved = Object.values(checks).every(Boolean);

  return {
    approved,
    currentMode,
    targetMode,
    currentBotMode: lifecycle.mode.mode,
    openXauusdPositions: openPositions,
    liveArmFilePresent: currentArmFile,
    checks,
    note: targetMode === "LIVE"
      ? "Sau switch: LIVE + PAUSE + DISARMED. ARM LIVE phải thực hiện riêng."
      : "LIVE sẽ được DISARM trước khi switch; sau switch: DEMO + PAUSE.",
  };
}

export async function createPhase7CAccountSwitchPreflight(targetMode: SwitchTarget) {
  cleanupExpiredTokens();
  const evaluation = await evaluateSwitch(targetMode);
  if (!evaluation.approved) return { ...evaluation, preflightToken: null, expiresAt: null };
  const createdAt = Date.now();
  const token = crypto.randomUUID();
  const item: PreflightToken = {
    token,
    targetMode,
    currentMode: evaluation.currentMode,
    createdAt,
    expiresAt: createdAt + PREFLIGHT_TTL_MS,
  };
  preflightTokens.set(token, item);
  return { ...evaluation, preflightToken: token, expiresAt: item.expiresAt };
}

export async function submitPhase7CAccountSwitch(input: {
  targetMode: SwitchTarget;
  preflightToken: string;
  confirmation: string;
}) {
  cleanupExpiredTokens();
  const token = preflightTokens.get(input.preflightToken);
  preflightTokens.delete(input.preflightToken);
  if (!token || token.targetMode !== input.targetMode || token.expiresAt <= Date.now()) {
    throw new Error("Preflight token không hợp lệ hoặc đã hết hạn. Hãy kiểm tra điều kiện lại.");
  }
  const expectedConfirmation = input.targetMode === "LIVE" ? "SWITCH_TO_LIVE" : "SWITCH_TO_DEMO";
  if (input.confirmation !== expectedConfirmation) {
    throw new Error(`Xác nhận không đúng. Hãy nhập chính xác ${expectedConfirmation}.`);
  }

  const fresh = await evaluateSwitch(input.targetMode);
  if (!fresh.approved || fresh.currentMode !== token.currentMode) {
    throw new Error("Điều kiện runtime đã thay đổi sau preflight. Không thực hiện switch; hãy kiểm tra lại.");
  }

  const existing = readStatus();
  if (existing?.status === "RUNNING" && Date.now() - existing.updatedAt <= REQUEST_RUNNING_STALE_MS) {
    throw new Error("Một account switch khác đang chạy.");
  }
  if (fs.existsSync(requestPath())) {
    throw new Error("Account switch request file đang tồn tại; không ghi đè yêu cầu chưa được xử lý.");
  }

  const requestId = crypto.randomUUID();
  const createdAt = Date.now();
  atomicWriteJson(requestPath(), {
    version: 1,
    requestId,
    targetMode: input.targetMode,
    confirmation: expectedConfirmation,
    source: "LOCAL_WEB",
    createdAt,
  });
  atomicWriteJson(statusPath(), {
    version: 1,
    requestId,
    targetMode: input.targetMode,
    status: "RUNNING",
    phase: "QUEUED",
    message: "Yêu cầu đã được tạo; đang chờ elevated guarded task.",
    startedAt: createdAt,
    updatedAt: createdAt,
    completedAt: null,
    finalAccountMode: fresh.currentMode,
    finalBotMode: fresh.currentBotMode,
    liveArmFilePresent: fresh.liveArmFilePresent,
  } satisfies Phase7CAccountSwitchStatus);

  try {
    await execFileAsync("schtasks.exe", ["/Run", "/TN", TASK_NAME], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 32 * 1024,
    });
  } catch (error) {
    try { fs.unlinkSync(requestPath()); } catch { /* request may already be consumed */ }
    const message = error instanceof Error ? error.message : "Không khởi chạy được elevated account-switch task.";
    atomicWriteJson(statusPath(), {
      version: 1,
      requestId,
      targetMode: input.targetMode,
      status: "FAIL",
      phase: "TASK_START_FAILED",
      message,
      startedAt: createdAt,
      updatedAt: Date.now(),
      completedAt: Date.now(),
      finalAccountMode: fresh.currentMode,
      finalBotMode: fresh.currentBotMode,
      liveArmFilePresent: armFilePresent(),
    } satisfies Phase7CAccountSwitchStatus);
    throw new Error("Không khởi chạy được elevated guarded account-switch task. Kiểm tra task registration/quyền Windows.");
  }

  return {
    accepted: true as const,
    requestId,
    targetMode: input.targetMode,
    status: "RUNNING" as const,
    message: "Đã gửi yêu cầu tới elevated guarded account-switch task.",
  };
}

export function getPhase7CAccountSwitchStatus(requestId?: string) {
  const status = readStatus();
  if (!status) return null;
  if (requestId && status.requestId !== requestId) return null;
  return status;
}
