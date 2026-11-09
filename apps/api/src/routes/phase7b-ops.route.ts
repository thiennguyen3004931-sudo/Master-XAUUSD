import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router, type Request, type Response } from "express";
import { getMt5Telemetry } from "../services/mt5.service";

const execFileAsync = promisify(execFile);
const router = Router();
const TELEGRAM_HEARTBEAT_STALE_MS = 10_000;
const BOT_START_TIMEOUT_MS = 30_000;
const TELEGRAM_START_TIMEOUT_MS = 15_000;
const BOT_TASK = "XAUUSD-Phase7B-Bot";
const TELEGRAM_TASK = "XAUUSD-Phase7B-Telegram";

type RuntimeState = {
  version?: number;
  status?: string;
  armed?: boolean;
  pid?: number | null;
  heartbeatAt?: number;
  startedAt?: number | null;
  intervalSeconds?: number;
};

type TelegramRuntimeState = {
  version?: number;
  status?: string;
  pid?: number | null;
  wrapperPid?: number | null;
  heartbeatAt?: number;
  startedAt?: string | null;
  intervalSeconds?: number;
  exitCode?: number | null;
};

type BotState = {
  accountLogin?: number | null;
  managed?: unknown | null;
};

router.get("/status", async (req: Request, res: Response) => {
  if (!isLoopback(req)) return res.status(403).json({ error: "Local controls require localhost." });

  try {
    const demoDir = resolveDemoDir();
    const runtime = demoDir ? readJsonIfExists<RuntimeState>(path.join(demoDir, "phase7b-demo-runtime.json")) : null;
    const telegramRuntime = demoDir ? readJsonIfExists<TelegramRuntimeState>(path.join(demoDir, "phase7b-telegram-runtime.json")) : null;
    const state = demoDir ? readJsonIfExists<BotState>(path.join(demoDir, "phase7b-demo-state.json")) : null;
    const botAlive = Boolean(runtime?.armed && isPidAlive(runtime.pid));
    const telegram = getTelegramRuntimeStatus(telegramRuntime);
    const telemetry = await getMt5Telemetry("XAUUSD").catch(() => null);
    const managedPosition = Boolean(state?.managed);

    return res.json({
      localOnly: true,
      controlEnabled: controlEnabled(req),
      generatedAt: Date.now(),
      bot: {
        alive: botAlive,
        armed: Boolean(runtime?.armed),
        status: runtime?.status ?? "STOPPED",
        pid: runtime?.pid ?? null,
        managedPosition,
        canStop: botAlive && !managedPosition,
      },
      telegram,
      bridge: telemetry
        ? {
            reachable: telemetry.reachable,
            status: telemetry.status,
            accountMode: telemetry.health?.accountMode ?? null,
            accountLogin: state?.accountLogin ?? null,
            server: telemetry.health?.server ?? null,
            tradingEnabled: telemetry.health?.tradingEnabled ?? null,
            terminalTradeAllowed: telemetry.health?.terminalTradeAllowed ?? null,
            expertTradeAllowed: telemetry.health?.expertTradeAllowed ?? null,
          }
        : {
            reachable: false,
            status: "OFFLINE",
            accountMode: null,
            accountLogin: state?.accountLogin ?? null,
            server: null,
            tradingEnabled: null,
            terminalTradeAllowed: null,
            expertTradeAllowed: null,
          },
      safety: {
        demoOnly: true,
        realAccountAllowed: false,
        directOrderRouteExposed: false,
        botStopBlockedWhileManaging: true,
        controlTransport: "LOCALHOST_ONLY",
        processLaunchMode: "WINDOWS_POWERSHELL_START_PROCESS",
        botStartVerification: "RUNTIME_PID_AND_HEARTBEAT",
        telegramStartVerification: "RUNTIME_PID_AND_HEARTBEAT",
      },
    });
  } catch (error) {
    return res.status(503).json({ error: errorMessage(error) });
  }
});

router.post("/bot/start", async (req: Request, res: Response) => {
  if (!controlEnabled(req)) return res.status(403).json({ error: "Bot control is disabled or request is not localhost." });

  try {
    const demoDir = requireDemoDir();
    const runtimePath = path.join(demoDir, "phase7b-demo-runtime.json");
    const currentRuntime = readJsonIfExists<RuntimeState>(runtimePath);
    if (currentRuntime?.armed && isPidAlive(currentRuntime.pid)) {
      return res.json({ accepted: true, action: "BOT_ALREADY_RUNNING", message: "Bot DEMO đang chạy.", pid: currentRuntime.pid });
    }

    const telemetry = await getMt5Telemetry("XAUUSD");
    assertDemoTradingReady(telemetry);

    const projectRoot = findProjectRoot();
    const script = path.join(projectRoot, "scripts", "run-phase7b-demo-local.ps1");
    if (!fs.existsSync(script)) return res.status(500).json({ error: `Missing bot script: ${script}` });

    const workRoot = path.dirname(demoDir);
    const fixedVolume = process.env.PHASE7B_FIXED_VOLUME?.trim() || "0.03";
    const logPath = path.join(demoDir, "phase7b-web-bot-start.log");
    const requestedAt = Date.now();
    prepareStartLog(logPath, `BOT START ${new Date(requestedAt).toISOString()} · volume=${fixedVolume}`);
    const launcherPid = await launchPowerShellViaWindowsHost(
      script,
      ["-WorkDir", workRoot, "-FixedVolume", fixedVolume, "-ArmDemoTrading"],
      logPath,
      "bot",
    );

    const runtime = await waitForBotRuntime(runtimePath, requestedAt, BOT_START_TIMEOUT_MS);
    if (!runtime) {
      if (isPidAlive(launcherPid)) await killProcessTree(launcherPid);
      const tail = readLogTail(logPath, 48);
      return res.status(503).json({
        error: `Bot DEMO không lên RUNNING trong ${BOT_START_TIMEOUT_MS / 1000} giây.\n\nLog cuối:\n${tail || "Không có log."}`,
        code: "BOT_START_VERIFICATION_FAILED",
        logPath,
      });
    }

    return res.json({
      accepted: true,
      action: "BOT_STARTED",
      message: `Bot DEMO đã RUNNING · ${fixedVolume} lot · PID ${runtime.pid}.`,
      pid: runtime.pid,
      demoOnly: true,
      realAccountAllowed: false,
    });
  } catch (error) {
    return res.status(409).json({ error: errorMessage(error) });
  }
});

router.post("/bot/stop", async (req: Request, res: Response) => {
  if (!controlEnabled(req)) return res.status(403).json({ error: "Bot control is disabled or request is not localhost." });

  try {
    const demoDir = requireDemoDir();
    const runtimePath = path.join(demoDir, "phase7b-demo-runtime.json");
    const state = readJsonIfExists<BotState>(path.join(demoDir, "phase7b-demo-state.json"));
    const runtime = readJsonIfExists<RuntimeState>(runtimePath);

    if (state?.managed) {
      return res.status(409).json({
        error: "Bot đang MANAGING một position. Không cho dừng controller cho đến khi position được đóng/quản lý xong.",
        code: "BOT_STOP_BLOCKED_MANAGED_POSITION",
      });
    }

    await endScheduledTaskIfExists(BOT_TASK);
    if (isPidAlive(runtime?.pid)) await killProcessTree(runtime!.pid!);
    markBotStopped(runtimePath, runtime);

    return res.json({ accepted: true, action: "BOT_STOPPED", message: "Bot DEMO đã dừng." });
  } catch (error) {
    return res.status(503).json({ error: errorMessage(error) });
  }
});

router.post("/telegram/start", async (req: Request, res: Response) => {
  if (!controlEnabled(req)) return res.status(403).json({ error: "Telegram control is disabled or request is not localhost." });

  try {
    const demoDir = requireDemoDir();
    const runtimePath = path.join(demoDir, "phase7b-telegram-runtime.json");
    const currentRuntime = readJsonIfExists<TelegramRuntimeState>(runtimePath);
    const currentStatus = getTelegramRuntimeStatus(currentRuntime);
    if (currentStatus.alive) {
      return res.json({ accepted: true, action: "TELEGRAM_ALREADY_RUNNING", message: "Telegram đang bật.", pid: currentStatus.pid });
    }

    const projectRoot = findProjectRoot();
    const script = path.join(projectRoot, "scripts", "run-phase7b-telegram-notifier-local.ps1");
    const envFile = path.join(projectRoot, ".env.phase7b-telegram");
    if (!fs.existsSync(script)) return res.status(500).json({ error: `Missing Telegram script: ${script}` });
    if (!fs.existsSync(envFile)) return res.status(409).json({ error: `Missing Telegram env: ${envFile}` });

    const logPath = path.join(demoDir, "phase7b-web-telegram-start.log");
    const requestedAt = Date.now();
    prepareStartLog(logPath, `TELEGRAM START ${new Date(requestedAt).toISOString()}`);
    const launcherPid = await launchPowerShellViaWindowsHost(
      script,
      ["-WorkDir", path.dirname(demoDir), "-EnvFile", envFile],
      logPath,
      "telegram",
    );

    const telegram = await waitForTelegramRuntime(runtimePath, requestedAt, TELEGRAM_START_TIMEOUT_MS);
    if (!telegram) {
      if (isPidAlive(launcherPid)) await killProcessTree(launcherPid);
      const tail = readLogTail(logPath, 48);
      return res.status(503).json({
        error: `Telegram không lên RUNNING trong ${TELEGRAM_START_TIMEOUT_MS / 1000} giây.\n\nLog cuối:\n${tail || "Không có log."}`,
        code: "TELEGRAM_START_VERIFICATION_FAILED",
        logPath,
      });
    }

    return res.json({
      accepted: true,
      action: "TELEGRAM_STARTED",
      message: `Telegram notifier đã ONLINE · PID ${telegram.pid}.`,
      pid: telegram.pid,
    });
  } catch (error) {
    return res.status(503).json({ error: errorMessage(error) });
  }
});

router.post("/telegram/stop", async (req: Request, res: Response) => {
  if (!controlEnabled(req)) return res.status(403).json({ error: "Telegram control is disabled or request is not localhost." });

  try {
    const demoDir = requireDemoDir();
    const runtimePath = path.join(demoDir, "phase7b-telegram-runtime.json");
    const runtime = readJsonIfExists<TelegramRuntimeState>(runtimePath);

    await endScheduledTaskIfExists(TELEGRAM_TASK);
    const pids = new Set<number>();
    if (Number.isInteger(runtime?.pid) && (runtime?.pid ?? 0) > 0) pids.add(runtime!.pid!);
    if (Number.isInteger(runtime?.wrapperPid) && (runtime?.wrapperPid ?? 0) > 0) pids.add(runtime!.wrapperPid!);
    for (const pid of pids) {
      if (isPidAlive(pid)) await killProcessTree(pid);
    }
    markTelegramStopped(runtimePath, runtime);

    return res.json({ accepted: true, action: "TELEGRAM_STOPPED", message: "Đã tắt thông báo Telegram." });
  } catch (error) {
    return res.status(503).json({ error: errorMessage(error) });
  }
});

router.post("/start", async (req: Request, res: Response) => {
  if (!controlEnabled(req)) return res.status(403).json({ error: "Local control disabled." });
  return res.status(410).json({ error: "Use /bot/start and /telegram/start separately." });
});

function resolveDemoDir(): string | null {
  const configured = process.env.PHASE7B_DEMO_WORK_DIR?.trim();
  if (!configured) return null;
  const resolved = path.resolve(configured);
  return path.basename(resolved).toLowerCase() === "phase7b-demo-forward" ? resolved : path.join(resolved, "phase7b-demo-forward");
}

function requireDemoDir(): string {
  const demoDir = resolveDemoDir();
  if (!demoDir) throw new Error("PHASE7B_DEMO_WORK_DIR is not configured for this API.");
  fs.mkdirSync(demoDir, { recursive: true });
  return demoDir;
}

function controlEnabled(req: Request): boolean {
  if (process.platform !== "win32" || !isLoopback(req) || !resolveDemoDir()) return false;
  return !/^(0|false|no|off)$/i.test(process.env.PHASE7B_LOCAL_CONTROL_ENABLED ?? "true");
}

function isLoopback(req: Request): boolean {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function findProjectRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml")) && fs.existsSync(path.join(current, "scripts"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Cannot locate project root from ${process.cwd()}.`);
}

function prepareStartLog(file: string, header: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `\n=== ${header} ===\n`, "utf8");
}

async function launchPowerShellViaWindowsHost(
  script: string,
  args: string[],
  logPath: string,
  kind: "bot" | "telegram",
): Promise<number> {
  const launcherPath = path.join(path.dirname(logPath), `phase7b-web-${kind}-launcher.ps1`);
  const invocation = [
    "& " + quotePowerShellLiteral(script),
    ...pairPowerShellArguments(args),
    "*>> " + quotePowerShellLiteral(logPath),
  ].join(" ");
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    `$Host.UI.RawUI.WindowTitle = 'XAUUSD Phase7B ${kind.toUpperCase()}'`,
    invocation,
  ].join("\r\n") + "\r\n";
  fs.writeFileSync(launcherPath, launcher, "utf8");

  const startCommand = [
    "$ErrorActionPreference='Stop'",
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${quotePowerShellLiteral(launcherPath)}) -WindowStyle Hidden -PassThru`,
    "$p.Id",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", startCommand],
    { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 },
  );
  const pid = Number(String(stdout).trim().split(/\r?\n/).at(-1));
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Windows PowerShell launcher did not return a valid ${kind} PID. Output=${String(stdout).trim()}`);
  }
  return pid;
}

function pairPowerShellArguments(args: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("-") && index + 1 < args.length && !args[index + 1].startsWith("-")) {
      output.push(value, quotePowerShellLiteral(args[index + 1]));
      index += 1;
    } else {
      output.push(value.startsWith("-") ? value : quotePowerShellLiteral(value));
    }
  }
  return output;
}

function quotePowerShellLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function waitForBotRuntime(file: string, requestedAt: number, timeoutMs: number): Promise<RuntimeState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = readJsonIfExists<RuntimeState>(file);
    const startedAt = Number(runtime?.startedAt ?? 0);
    const heartbeatAge = runtime?.heartbeatAt ? Math.max(0, Date.now() - Number(runtime.heartbeatAt)) : Number.POSITIVE_INFINITY;
    if (
      runtime?.status === "RUNNING" &&
      runtime.armed === true &&
      startedAt >= requestedAt - 2_000 &&
      heartbeatAge <= 10_000 &&
      isPidAlive(runtime.pid)
    ) {
      return runtime;
    }
    await sleep(500);
  }
  return null;
}

async function waitForTelegramRuntime(file: string, requestedAt: number, timeoutMs: number): Promise<TelegramRuntimeState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = readJsonIfExists<TelegramRuntimeState>(file);
    const startedAt = runtime?.startedAt ? Date.parse(runtime.startedAt) : 0;
    const status = getTelegramRuntimeStatus(runtime);
    if (status.alive && startedAt >= requestedAt - 2_000) return runtime;
    await sleep(500);
  }
  return null;
}

function readLogTail(file: string, maxLines: number): string {
  if (!fs.existsSync(file)) return "";
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).slice(-maxLines).join("\n").trim();
  } catch {
    return "";
  }
}

function assertDemoTradingReady(telemetry: Awaited<ReturnType<typeof getMt5Telemetry>>): void {
  if (!telemetry.reachable) throw new Error("MT5 Bridge chưa kết nối.");
  if (telemetry.health?.accountMode !== "demo") throw new Error(`Chỉ cho phép DEMO. accountMode=${telemetry.health?.accountMode ?? "unknown"}`);
  if (telemetry.health?.tradingEnabled !== true) throw new Error("Bridge trading chưa bật.");
  if (telemetry.health?.terminalTradeAllowed !== true) throw new Error("MT5 terminal chưa cho phép trading.");
  if (telemetry.health?.expertTradeAllowed !== true) throw new Error("MT5 Expert/Algo Trading chưa bật.");
}

async function endScheduledTaskIfExists(taskName: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await execFileAsync("schtasks.exe", ["/End", "/TN", taskName], { windowsHide: true, timeout: 5_000, maxBuffer: 32 * 1024 });
  } catch {
    // Missing/not-running task is fine. Direct-process control below is authoritative.
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000, maxBuffer: 32 * 1024 });
  } catch {
    // The process may already have exited.
  }
}

function markBotStopped(file: string, runtime: RuntimeState | null): void {
  const payload = {
    ...(runtime ?? {}),
    version: runtime?.version ?? 1,
    status: "STOPPED",
    armed: false,
    pid: null,
    heartbeatAt: Date.now(),
  };
  writeJson(file, payload);
}

function markTelegramStopped(file: string, runtime: TelegramRuntimeState | null): void {
  const payload = {
    ...(runtime ?? {}),
    version: runtime?.version ?? 1,
    status: "STOPPED",
    pid: null,
    wrapperPid: null,
    heartbeatAt: Date.now(),
    exitCode: 0,
  };
  writeJson(file, payload);
}

function getTelegramRuntimeStatus(runtime: TelegramRuntimeState | null) {
  const heartbeatAt = Number(runtime?.heartbeatAt ?? 0);
  const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, Date.now() - heartbeatAt) : null;
  const pidAlive = isPidAlive(runtime?.pid);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= TELEGRAM_HEARTBEAT_STALE_MS;
  const alive = Boolean(runtime?.status === "RUNNING" && pidAlive && heartbeatFresh);
  return {
    alive,
    status: runtime?.status ?? "STOPPED",
    pid: runtime?.pid ?? null,
    wrapperPid: runtime?.wrapperPid ?? null,
    heartbeatAt: heartbeatAt || null,
    heartbeatAgeMs,
    heartbeatFresh,
  };
}

function readJsonIfExists<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default router;
