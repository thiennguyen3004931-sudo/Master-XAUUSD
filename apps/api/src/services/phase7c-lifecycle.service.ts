import fs from "node:fs";
import path from "node:path";
import { phase7CBotModeService } from "./phase7c-bot-mode.service";
import { activatePhase7CAccountRiskProfile } from "./phase7c-account-profile-selection.service";
import { phase7CLotSettingsService } from "./phase7c-lot-settings.service";
import {
  accountModeAllowsBroker,
  getPhase7CAccountModeState,
  setPhase7CAccountModeFromWebAutoDetection,
  type Phase7CAccountMode,
} from "./phase7c-account-mode.service";
import {
  ensurePhase7CLiveAuthorizationForWebStart,
  getPhase7CLiveAuthorizationStatus,
  preserveLegacyExplicitLiveAuthorization,
  type Phase7CLiveAuthorizationStatus,
} from "./phase7c-live-authorization.service";
import { resolvePhase7CWebStartAccount } from "./phase7c-web-account-start-policy";
import { getMt5Telemetry, type Mt5TelemetrySnapshot } from "./mt5.service";
import {
  getPhase7CLifecycleBrokerClientStatus,
  submitPhase7CLifecycleBrokerRequest,
  type Phase7CLifecycleBrokerAction,
  type Phase7CLifecycleBrokerReason,
  type Phase7CLifecycleBrokerRequestSource,
} from "./phase7c-lifecycle-broker.service";

const START_TIMEOUT_MS = 50_000;
const START_READY_STABLE_MS = 5_000;
const STOP_VERIFY_TIMEOUT_MS = 10_000;
const TELEGRAM_STALE_MS = 15_000;

export type Phase7CLifecycleStartProvenance =
  | "web-control-center-start"
  | "local-lifecycle-api-start";

export type Phase7CLifecycleStopProvenance =
  | "web-control-center-stop"
  | "local-lifecycle-api-stop";

export type Phase7CReadyWaitDecision =
  | { state: "WAITING_FOR_READY"; readySince: null }
  | { state: "WAITING_FOR_STABILITY"; readySince: number }
  | { state: "PASS"; readySince: number }
  | { state: "FAIL"; readySince: null };

export function evaluatePhase7CReadyWindow(input: {
  startedAt: number;
  now: number;
  ready: boolean;
  readySince: number | null;
  acquireTimeoutMs?: number;
  stableMs?: number;
}): Phase7CReadyWaitDecision {
  const acquireTimeoutMs = input.acquireTimeoutMs ?? START_TIMEOUT_MS;
  const stableMs = input.stableMs ?? START_READY_STABLE_MS;
  const acquireDeadline = input.startedAt + acquireTimeoutMs;

  if (input.ready) {
    if (input.readySince === null && input.now >= acquireDeadline) {
      return { state: "FAIL", readySince: null };
    }
    const nextReadySince = input.readySince ?? input.now;
    if (input.now - nextReadySince >= stableMs) {
      return { state: "PASS", readySince: nextReadySince };
    }
    return { state: "WAITING_FOR_STABILITY", readySince: nextReadySince };
  }

  if (input.now >= acquireDeadline) {
    return { state: "FAIL", readySince: null };
  }

  return { state: "WAITING_FOR_READY", readySince: null };
}

type TelegramModeStatus = {
  ready?: boolean;
  status?: string;
  pid?: number | null;
  mode?: string;
  updatedAt?: number;
  lastTelegramSuccessAt?: number | null;
};

function runtimeRoot(): string {
  const configured = process.env.PHASE7C_RUNTIME_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const demoDir = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (demoDir) return path.resolve(demoDir, "..");
  return path.resolve(process.cwd(), ".runtime");
}

function executorRuntime(): string {
  return path.join(runtimeRoot(), "phase7c-executors");
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let index = 0; index < 8; index += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) && fs.existsSync(path.join(current, "scripts"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot locate project root from ${process.cwd()}.`);
}

function accountEnvFile(accountMode: Phase7CAccountMode): string {
  return path.join(
    findProjectRoot(),
    "packages",
    "mt5-broker",
    "bridge",
    accountMode === "LIVE" ? ".env.phase7b-live" : ".env.phase7b-demo",
  );
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

function readPid(file: string): number | null {
  try {
    const value = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function telegramConfigured(): boolean {
  try {
    const text = fs.readFileSync(path.join(findProjectRoot(), ".env.phase7b-telegram"), "utf8");
    return /^ZIQ_TELEGRAM_BOT_TOKEN=.+$/m.test(text) && /^ZIQ_TELEGRAM_CHAT_ID=.+$/m.test(text);
  } catch {
    return false;
  }
}

function controlEnabled(): boolean {
  if (process.platform !== "win32") return false;
  return !/^(?:0|false|no|off)$/i.test(process.env.PHASE7B_LOCAL_CONTROL_ENABLED ?? "true");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getPhase7CLifecycleRuntimeStatus() {
  const root = executorRuntime();
  const accountModeState = getPhase7CAccountModeState();
  const supervisorPid = readPid(path.join(root, "supervisor.pid"));
  const trendPid = readPid(path.join(root, "trend.pid"));
  const sidewayPid = readPid(path.join(root, "sideway.pid"));
  const telegramPid = readPid(path.join(root, "telegram-mode.pid"));
  const regimeNotifierPid = readPid(path.join(root, "regime-notifier.pid"));
  const telegram = readJson<TelegramModeStatus>(path.join(root, "telegram-mode-status.json"));
  const telegramUpdatedAt = Number(telegram?.updatedAt ?? telegram?.lastTelegramSuccessAt ?? 0);
  const telegramHeartbeatAgeMs = telegramUpdatedAt > 0
    ? Math.max(0, Date.now() - telegramUpdatedAt)
    : null;
  const processes = {
    supervisor: { pid: supervisorPid, alive: isPidAlive(supervisorPid) },
    trend: { pid: trendPid, alive: isPidAlive(trendPid) },
    sideway: { pid: sidewayPid, alive: isPidAlive(sidewayPid) },
    telegram: { pid: telegramPid, alive: isPidAlive(telegramPid) },
    regimeNotifier: { pid: regimeNotifierPid, alive: isPidAlive(regimeNotifierPid) },
  };
  const lots = phase7CLotSettingsService.get();
  const broker = getPhase7CLifecycleBrokerClientStatus();
  const running = processes.supervisor.alive && processes.trend.alive && processes.sideway.alive;
  const brokerOwnsExecutorTree = Boolean(
    broker.heartbeat?.state === "RUNNING" &&
    broker.status?.state === "RUNNING" &&
    broker.heartbeat?.desiredExecutorState === "RUNNING" &&
    broker.status?.desiredExecutorState === "RUNNING" &&
    supervisorPid !== null &&
    broker.status?.supervisorPid === supervisorPid,
  );
  const telegramReady = Boolean(
    processes.telegram.alive &&
    processes.regimeNotifier.alive &&
    telegram?.ready === true &&
    telegram?.status === "READY" &&
    telegramHeartbeatAgeMs !== null &&
    telegramHeartbeatAgeMs <= TELEGRAM_STALE_MS,
  );
  const ready = broker.ready && brokerOwnsExecutorTree && accountModeState.valid && running && telegramReady && lots.activeAlive && !lots.restartRequired;

  return {
    controlEnabled: controlEnabled(),
    running,
    ready,
    broker,
    accountMode: accountModeState,
    telegramConfigured: telegramConfigured(),
    telegramReady,
    telegramStatus: telegram?.status ?? "STOPPED",
    telegramHeartbeatAgeMs,
    mode: phase7CBotModeService.get(),
    processes,
    lotSettings: {
      configured: lots.state,
      active: lots.active,
      activeAlive: lots.activeAlive,
      restartRequired: lots.restartRequired,
    },
    safety: {
      localhostOnly: true as const,
      accountMode: accountModeState.accountMode,
      demoOnly: accountModeState.accountMode === "DEMO",
      realAccountAllowed: accountModeState.accountMode === "LIVE" && accountModeState.liveExecutionEnabled,
      accountGuardValid: accountModeState.valid,
      accountSwitchFromWeb: false as const,
      accountSelectionFromWeb: true as const,
      liveColdStartFromWeb: true as const,
      firstTimeLiveArmFromWeb: false as const,
      startMode: "PAUSE_UNTIL_MANUAL_WEB_AUTO" as const,
      stopBlockedWithOpenPosition: true as const,
      mt5PanelOrderPermission: "NONE" as const,
    },
  };
}

export function assertPhase7CSelectedAccountReady(telemetry: Mt5TelemetrySnapshot): void {
  const accountModeState = getPhase7CAccountModeState();
  if (!accountModeState.valid) {
    throw new Error(`Account-mode state không hợp lệ. ${accountModeState.error ?? ""}`.trim());
  }
  if (!telemetry.reachable) throw new Error("MT5 Bridge chưa kết nối.");
  if (!accountModeAllowsBroker(telemetry.health?.accountMode, accountModeState)) {
    throw new Error(
      `MT5 account không khớp cấu hình ${accountModeState.accountMode}. broker=${telemetry.health?.accountMode ?? "unknown"}`,
    );
  }
  if (telemetry.health?.tradingEnabled !== true) throw new Error("Bridge trading chưa bật.");
  if (telemetry.health?.terminalTradeAllowed !== true) throw new Error("MT5 terminal chưa cho phép trading.");
  if (telemetry.health?.expertTradeAllowed !== true) throw new Error("MT5 Algo/Expert Trading chưa bật.");
}

export const assertPhase7CDemoReady = assertPhase7CSelectedAccountReady;

async function waitForReady(timeoutMs = START_TIMEOUT_MS) {
  const startedAt = Date.now();
  let readySince: number | null = null;
  while (true) {
    const status = getPhase7CLifecycleRuntimeStatus();
    const now = Date.now();
    const decision = evaluatePhase7CReadyWindow({
      startedAt,
      now,
      ready: status.ready,
      readySince,
      acquireTimeoutMs: timeoutMs,
      stableMs: START_READY_STABLE_MS,
    });
    if (decision.state === "PASS") return status;
    if (decision.state === "FAIL") return null;
    readySince = decision.readySince;
    await sleep(500);
  }
}

async function waitForStopped(timeoutMs = STOP_VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getPhase7CLifecycleRuntimeStatus();
    if (!status.running && !Object.values(status.processes).some((entry) => entry.alive)) return status;
    await sleep(250);
  }
  return getPhase7CLifecycleRuntimeStatus();
}

function liveAuthorizationError(status: Phase7CLiveAuthorizationStatus): string {
  return status.error ? `${status.reason}: ${status.error}` : status.reason;
}

function chooseStartBrokerAction(current: ReturnType<typeof getPhase7CLifecycleRuntimeStatus>): {
  action: Phase7CLifecycleBrokerAction;
  reason: Phase7CLifecycleBrokerReason;
} {
  const anyExecutorAlive = current.running || Object.values(current.processes).some((entry) => entry.alive);
  if (anyExecutorAlive) {
    return {
      action: "RESTART",
      reason: current.lotSettings.restartRequired ? "LOT_SETTINGS_CHANGED" : "RECOVERY_START",
    };
  }
  return { action: "START", reason: "USER_START" };
}

export async function startPhase7CFromWeb(
  telemetry: Mt5TelemetrySnapshot,
  provenance: Phase7CLifecycleStartProvenance,
) {
  if (!controlEnabled()) throw new Error("Điều khiển Bot chỉ khả dụng trên localhost Windows.");

  if (provenance === "local-lifecycle-api-start") {
    phase7CBotModeService.set("PAUSE", provenance);
  } else {
    phase7CBotModeService.set("PAUSE", "web-control-center-preflight");
  }
  const initialAccountState = getPhase7CAccountModeState();
  let liveAuthorization = getPhase7CLiveAuthorizationStatus(
    telemetry.health?.server ?? null,
    telemetry.accountLogin,
  );
  let targetAccountMode: Phase7CAccountMode = initialAccountState.accountMode;

  if (provenance === "local-lifecycle-api-start") {
    if (!initialAccountState.valid) {
      throw new Error(`Account-mode state không hợp lệ. ${initialAccountState.error ?? ""}`.trim());
    }
    targetAccountMode = initialAccountState.accountMode;
    if (targetAccountMode === "LIVE" && (!liveAuthorization.valid || !liveAuthorization.identity)) {
      throw new Error(`LIVE authorization không hợp lệ: ${liveAuthorizationError(liveAuthorization)}. Bot giữ PAUSE.`);
    }
  }

  if (provenance === "web-control-center-start") {
    const accountDecision = resolvePhase7CWebStartAccount({
      reachable: telemetry.reachable,
      brokerAccountMode: telemetry.health?.accountMode ?? null,
      currentState: initialAccountState,
      durableLiveAuthorizationValid: liveAuthorization.valid,
    });
    if (!accountDecision.allowed || !accountDecision.targetAccountMode) {
      throw new Error(
        accountDecision.reason === "LIVE_NOT_PREAUTHORIZED"
          ? "MT5 đang đăng nhập LIVE nhưng tài khoản LIVE này chưa được cấp quyền trước. Web không tự ARM LIVE lần đầu; hãy dùng flow Admin -ConfirmLiveExecution một lần. Bot giữ PAUSE."
          : `Không thể chọn account runtime từ MT5 hiện tại: ${accountDecision.reason}. Bot giữ PAUSE.`,
      );
    }

    targetAccountMode = accountDecision.targetAccountMode;
    if (targetAccountMode === "LIVE") {
      if (accountDecision.authorizationSource === "LEGACY_EXPLICIT_LIVE_STATE") {
        liveAuthorization = ensurePhase7CLiveAuthorizationForWebStart(
          telemetry.health?.server ?? null,
          telemetry.accountLogin,
        );
      }
      if (!liveAuthorization.valid || !liveAuthorization.identity) {
        throw new Error(`LIVE authorization không hợp lệ: ${liveAuthorizationError(liveAuthorization)}. Bot giữ PAUSE.`);
      }
    } else if (
      initialAccountState.valid &&
      initialAccountState.accountMode === "LIVE" &&
      initialAccountState.liveExecutionEnabled
    ) {
      preserveLegacyExplicitLiveAuthorization();
    }

    if (initialAccountState.accountMode !== targetAccountMode) {
      const liveIdentity = targetAccountMode === "LIVE" ? liveAuthorization.identity : null;
      activatePhase7CAccountRiskProfile({
        accountMode: targetAccountMode,
        liveIdentity,
        updatedBy: `web-auto-detect:${targetAccountMode}`,
      });
      setPhase7CAccountModeFromWebAutoDetection({
        accountMode: targetAccountMode,
        envFile: accountEnvFile(targetAccountMode),
        liveAuthorizationValidated: targetAccountMode === "LIVE",
        updatedBy: `web-auto-detect:${targetAccountMode}`,
      });
    }
  }

  const brokerSource: Phase7CLifecycleBrokerRequestSource = provenance === "local-lifecycle-api-start"
    ? "LOCAL_LIFECYCLE_API"
    : "WEB_CONTROL_CENTER";

  assertPhase7CSelectedAccountReady(telemetry);
  if (telemetry.positions.length > 0) {
    throw new Error(`Không khởi động sạch khi đang có ${telemetry.positions.length} vị thế XAUUSD. Hãy kiểm tra/quản lý vị thế trước.`);
  }
  if (!telegramConfigured()) throw new Error("Telegram chưa được cấu hình; không bật Bot khi thiếu kênh thông báo.");

  const accountModeState = getPhase7CAccountModeState();
  const current = getPhase7CLifecycleRuntimeStatus();
  if (!current.broker.ready) {
    throw new Error("Lifecycle broker SYSTEM chưa READY. Bot giữ PAUSE; không thực hiện mutation từ Web user.");
  }
  if (current.ready) {
    const mode = provenance === "local-lifecycle-api-start"
      ? phase7CBotModeService.set("PAUSE", provenance)
      : phase7CBotModeService.set("PAUSE", "web-control-center-ready-pause");
    return {
      action: "ALREADY_RUNNING",
      message: `Bot ${accountModeState.accountMode} đã chạy và đã verify; giữ PAUSE. Bật AUTO thủ công từ Web khi sẵn sàng.`,
      accountMode: accountModeState.accountMode,
      mode,
      lifecycle: getPhase7CLifecycleRuntimeStatus(),
    };
  }

  const brokerRequest = chooseStartBrokerAction(current);
  const brokerResult = await submitPhase7CLifecycleBrokerRequest(brokerRequest.action, brokerRequest.reason, brokerSource);
  const ready = await waitForReady();
  if (!ready) {
    if (provenance === "local-lifecycle-api-start") {
      phase7CBotModeService.set("PAUSE", provenance);
    } else {
      phase7CBotModeService.set("PAUSE", "web-control-center-start-failed");
    }
    await submitPhase7CLifecycleBrokerRequest("STOP", "USER_STOP", brokerSource).catch(() => undefined);
    throw new Error(`Bot chưa đạt READY trong ${START_TIMEOUT_MS / 1000} giây; broker đã được yêu cầu dừng executor và Bot giữ PAUSE.`);
  }

  try {
    const finalTelemetry = await getMt5Telemetry("XAUUSD");
    assertPhase7CSelectedAccountReady(finalTelemetry);
    if (finalTelemetry.health?.accountMode !== (targetAccountMode === "LIVE" ? "real" : "demo")) {
      throw new Error(`MT5 account mode đổi trong lúc khởi động. target=${targetAccountMode}; broker=${finalTelemetry.health?.accountMode ?? "unknown"}.`);
    }
    if (targetAccountMode === "LIVE") {
      const finalAuthorization = getPhase7CLiveAuthorizationStatus(
        finalTelemetry.health?.server ?? null,
        finalTelemetry.accountLogin,
      );
      if (!finalAuthorization.valid) {
        throw new Error(`LIVE authorization đổi/không còn hợp lệ: ${liveAuthorizationError(finalAuthorization)}.`);
      }
    }
    if (finalTelemetry.positions.length > 0) {
      throw new Error(`Phát hiện ${finalTelemetry.positions.length} vị thế XAUUSD trong lúc khởi động.`);
    }
  } catch (error) {
    if (provenance === "local-lifecycle-api-start") {
      phase7CBotModeService.set("PAUSE", provenance);
    } else {
      phase7CBotModeService.set("PAUSE", "web-control-center-final-preflight-failed");
    }
    await submitPhase7CLifecycleBrokerRequest("STOP", "USER_STOP", brokerSource).catch(() => undefined);
    throw new Error(`Kiểm tra cuối trước READY thất bại; broker đã được yêu cầu dừng executor và giữ PAUSE. ${error instanceof Error ? error.message : String(error)}`);
  }

  const mode = provenance === "local-lifecycle-api-start"
    ? phase7CBotModeService.set("PAUSE", provenance)
    : phase7CBotModeService.set("PAUSE", "web-control-center-ready-pause");
  return {
    action: brokerRequest.action === "RESTART" ? "RESTARTED" : "STARTED",
    brokerReasonCode: brokerResult.reasonCode,
    message: `Bot ${targetAccountMode} đã RUNNING · PAUSE · Trend ${ready.lotSettings.configured.trendFixedLot.toFixed(2)} lot · Telegram READY. Bật AUTO thủ công từ Web khi sẵn sàng.`,
    supervisorPid: brokerResult.supervisorPid ?? ready.processes.supervisor.pid,
    accountMode: targetAccountMode,
    mode,
    lifecycle: getPhase7CLifecycleRuntimeStatus(),
  };
}

export async function stopPhase7C(
  telemetry: Mt5TelemetrySnapshot,
  provenance: Phase7CLifecycleStopProvenance,
) {
  if (!controlEnabled()) throw new Error("Điều khiển Bot chỉ khả dụng trên localhost Windows.");
  assertPhase7CSelectedAccountReady(telemetry);
  if (telemetry.positions.length > 0) {
    throw new Error("Bot đang có vị thế XAUUSD. Không cho dừng executor để tránh bỏ lệnh không được quản lý.");
  }

  const accountModeState = getPhase7CAccountModeState();
  const mode = phase7CBotModeService.set("PAUSE", provenance);
  const broker = getPhase7CLifecycleBrokerClientStatus();
  if (!broker.ready) {
    throw new Error("Lifecycle broker SYSTEM chưa READY; không cho Web user tự dừng privileged executor tree.");
  }
  const brokerSource: Phase7CLifecycleBrokerRequestSource = provenance === "local-lifecycle-api-stop"
    ? "LOCAL_LIFECYCLE_API"
    : "WEB_CONTROL_CENTER";
  const result = await submitPhase7CLifecycleBrokerRequest("STOP", "USER_STOP", brokerSource);
  const lifecycle = await waitForStopped();
  if (lifecycle.running || Object.values(lifecycle.processes).some((entry) => entry.alive)) {
    throw new Error("Executor vẫn còn chạy sau lệnh STOP của broker. Giữ PAUSE và kiểm tra Lifecycle Broker/Scheduled Task.");
  }
  return {
    action: "STOPPED",
    brokerReasonCode: result.reasonCode,
    message: `Bot ${accountModeState.accountMode} đã dừng an toàn · broker vẫn chạy · mode PAUSE · Web/MT5 Bridge vẫn hoạt động.`,
    accountMode: accountModeState.accountMode,
    mode,
    lifecycle,
  };
}