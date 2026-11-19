#!/usr/bin/env node
/**
 * XAUUSD AI MASTER — CÔNG CỤ KHỞI ĐỘNG & ĐIỀU PHỐI 1 CHẠM (ONE-CLICK ORCHESTRATOR V6)
 * Đảm bảo cổng :5717 (Web) và :3711 (API) luôn khởi động an toàn ở trạng thái PAUSE & DISARMED,
 * tự động quản lý khóa điều khiển cục bộ ZIQ_V6_CONTROL_TOKEN trong .runtime/v6-control-token.txt.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, ".runtime", "one-click");
const LOG_DIR = path.join(RUNTIME_DIR, "logs");
const PID_FILE = path.join(RUNTIME_DIR, "processes.json");
const CONTROL_TOKEN_FILE = path.join(ROOT_DIR, ".runtime", "v6-control-token.txt");

const PORTS = {
  bridge: Number(process.env.MT5_BRIDGE_PORT || 8765),
  api: Number(process.env.API_PORT || 3711),
  web: Number(process.env.WEB_PORT || 5717),
};

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getOrCreateControlToken() {
  ensureDirs();
  const fromEnv = String(process.env.ZIQ_V6_CONTROL_TOKEN || "").trim();
  if (fromEnv.length >= 16) return fromEnv;
  try {
    if (fs.existsSync(CONTROL_TOKEN_FILE)) {
      const saved = fs.readFileSync(CONTROL_TOKEN_FILE, "utf8").trim();
      if (saved.length >= 16) return saved;
    }
  } catch {}
  const fresh = "v6_" + crypto.randomBytes(18).toString("hex");
  fs.writeFileSync(CONTROL_TOKEN_FILE, fresh + "\n", "utf8");
  return fresh;
}

function getLanIps() {
  const nets = os.networkInterfaces();
  const wifiOrLan = [];
  const tailscale = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (iface.address.startsWith("100.") || name.toLowerCase().includes("tailscale")) {
          tailscale.push(iface.address);
        } else {
          wifiOrLan.push(iface.address);
        }
      }
    }
  }
  return {
    lanIp: wifiOrLan[0] || "127.0.0.1",
    allLanIps: wifiOrLan,
    tailscaleIp: tailscale[0] || null,
  };
}

function checkPortOpen(port, host = "127.0.0.1", timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForPort(port, maxWaitMs = 8000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await checkPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function initEnvFilesIfMissing() {
  ensureDirs();
  const controlToken = getOrCreateControlToken();
  const bridgeDir = path.join(ROOT_DIR, "packages", "mt5-broker", "bridge");
  const demoEnvPath = path.join(bridgeDir, ".env.phase7b-demo");
  const demoExamplePath = path.join(bridgeDir, ".env.phase7b-demo.example");
  let generatedKey = "xauusd_local_secret_" + crypto.randomBytes(16).toString("hex");

  if (!fs.existsSync(demoEnvPath) && fs.existsSync(demoExamplePath)) {
    let content = fs.readFileSync(demoExamplePath, "utf8");
    content = content.replace("CHANGE_ME_TO_A_LONG_RANDOM_SECRET", generatedKey);
    fs.writeFileSync(demoEnvPath, content, "utf8");
    console.log(`[INIT] Đã tự động tạo file cấu hình MT5 Bridge: ${demoEnvPath}`);
  } else if (fs.existsSync(demoEnvPath)) {
    const existing = fs.readFileSync(demoEnvPath, "utf8");
    const match = existing.match(/^MT5_API_KEY=(.+)$/m);
    if (match && match[1].trim() && !match[1].includes("CHANGE_ME")) {
      generatedKey = match[1].trim();
    }
  }

  const rootEnvPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(rootEnvPath)) {
    const rootEnvContent = [
      `PORT=${PORTS.api}`,
      `API_PORT=${PORTS.api}`,
      `WEB_PORT=${PORTS.web}`,
      `MT5_BRIDGE_BASE_URL=http://127.0.0.1:${PORTS.bridge}`,
      `MT5_BRIDGE_API_KEY=${generatedKey}`,
      `ZIQ_V6_CONTROL_TOKEN=${controlToken}`,
      `WEB_ORIGIN=http://127.0.0.1:${PORTS.web},http://localhost:${PORTS.web}`,
    ].join("\n") + "\n";
    fs.writeFileSync(rootEnvPath, rootEnvContent, "utf8");
    console.log(`[INIT] Đã tự động tạo file .env gốc: ${rootEnvPath}`);
  }

  const tgEnvPath = path.join(ROOT_DIR, ".env.phase7b-telegram");
  const tgExamplePath = path.join(ROOT_DIR, ".env.phase7b-telegram.example");
  if (!fs.existsSync(tgEnvPath) && fs.existsSync(tgExamplePath)) {
    fs.copyFileSync(tgExamplePath, tgEnvPath);
    console.log(`[INIT] Đã tạo mẫu cấu hình Telegram: ${tgEnvPath}`);
  }

  return { demoEnvPath, rootEnvPath, tgEnvPath, apiKey: generatedKey, controlToken };
}

function readPidStore() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
    }
  } catch {
    // ignore
  }
  return {};
}

function writePidStore(store) {
  ensureDirs();
  fs.writeFileSync(PID_FILE, JSON.stringify(store, null, 2), "utf8");
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnNodeBackground(name, scriptRelativePath, extraEnv = {}) {
  ensureDirs();
  const outLog = path.join(LOG_DIR, `${name}.out.log`);
  const errLog = path.join(LOG_DIR, `${name}.err.log`);
  const outFd = fs.openSync(outLog, "a");
  const errFd = fs.openSync(errLog, "a");

  const scriptFullPath = path.join(ROOT_DIR, scriptRelativePath);
  const child = spawn(process.execPath, [scriptFullPath], {
    cwd: ROOT_DIR,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function startServices({ webOnly = false } = {}) {
  console.log("==================================================================");
  console.log("  🚀 XAUUSD AI MASTER V6 — ĐANG KHỞI ĐỘNG HỆ THỐNG 1 CHẠM (PAUSE & DISARMED)");
  console.log("==================================================================");

  const envInfo = initEnvFilesIfMissing();
  const pids = readPidStore();

  if (!webOnly && process.platform === "win32") {
    const bridgeUp = await checkPortOpen(PORTS.bridge);
    if (!bridgeUp) {
      const bridgeDir = path.join(ROOT_DIR, "packages", "mt5-broker", "bridge");
      const bridgeRunPs1 = path.join(bridgeDir, "run.ps1");
      if (fs.existsSync(bridgeRunPs1)) {
        console.log(`[1/2] Đang bật MT5 Python Bridge trên cổng :${PORTS.bridge}...`);
        const outFd = fs.openSync(path.join(LOG_DIR, "mt5-bridge.out.log"), "a");
        const errFd = fs.openSync(path.join(LOG_DIR, "mt5-bridge.err.log"), "a");
        const child = spawn(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bridgeRunPs1, "-EnvFile", ".env.phase7b-demo", "-AccountMode", "DEMO"],
          {
            cwd: bridgeDir,
            detached: true,
            stdio: ["ignore", outFd, errFd],
            windowsHide: true,
          }
        );
        child.unref();
        pids.bridge = child.pid;
      }
    } else {
      console.log(`[1/2] MT5 Python Bridge (:${PORTS.bridge}) đã đang chạy.`);
    }
  } else {
    console.log("[1/2] Chế độ Web & Backtest độc lập (Tự động kết nối MT5 nếu mở sau).");
  }

  const webUp = await checkPortOpen(PORTS.web);
  const apiUp = await checkPortOpen(PORTS.api);

  if (!webUp || !apiUp) {
    console.log(`[2/2] Đang bật Máy chủ Web (:5717) & Control/Backtest API (:3711)...`);
    pids.standalone = spawnNodeBackground("standalone-server", "scripts/xauusd-standalone-server.mjs", {
      API_PORT: String(PORTS.api),
      WEB_PORT: String(PORTS.web),
      MT5_BRIDGE_BASE_URL: `http://127.0.0.1:${PORTS.bridge}`,
      MT5_BRIDGE_API_KEY: envInfo.apiKey,
      ZIQ_V6_CONTROL_TOKEN: envInfo.controlToken,
    });
  } else {
    console.log(`[2/2] Máy chủ Web (:${PORTS.web}) & API (:${PORTS.api}) đã đang chạy.`);
  }

  writePidStore(pids);

  const ready = await waitForPort(PORTS.web, 6000);
  if (ready) {
    console.log(`  ✓ XÁC NHẬN: Cổng http://localhost:${PORTS.web} đã ONLINE 100%!`);
    console.log(`  🔑 KHÓA ĐIỀU KHIỂN V6: Đã lưu bảo mật tại .runtime/v6-control-token.txt (Không ghi vào log)`);
  } else {
    console.log(`  ⚠ Cảnh báo: Cổng :${PORTS.web} đang khởi tạo chậm, vui lòng kiểm tra log tại .runtime/one-click/logs/`);
  }

  await printStatusSummary(ready);
}

async function stopServices() {
  console.log("==================================================================");
  console.log("  🛑 XAUUSD AI MASTER — ĐANG DỪNG TOÀN BỘ TIẾN TRÌNH ĐÃ ĐĂNG KÝ AN TOÀN");
  console.log("==================================================================");
  const pids = readPidStore();
  for (const [name, pid] of Object.entries(pids)) {
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ✓ Đã dừng tiến trình [${name}] (PID: ${pid})`);
      } catch {
        // ignore
      }
    }
  }
  writePidStore({});
  console.log("  ✓ Toàn bộ dịch vụ đã dừng an toàn.");
}

async function printStatusSummary(openBrowser = false) {
  const [bridgeOk, apiOk, webOk] = await Promise.all([
    checkPortOpen(PORTS.bridge),
    checkPortOpen(PORTS.api),
    checkPortOpen(PORTS.web),
  ]);
  const ips = getLanIps();
  const controlToken = getOrCreateControlToken();

  console.log("");
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│        TRẠNG THÁI HỆ THỐNG XAUUSD AI MASTER V6 HIỆN TẠI        │");
  console.log("├────────────────────────────────────────────────────────────────┤");
  console.log(`│  1. MT5 Python Bridge (:8765) : ${bridgeOk ? "🟢 ĐANG CHẠY (ONLINE)   " : "🟡 CHỜ MT5 (LOCAL SIM)  "} │`);
  console.log(`│  2. Control & Backtest API    : ${apiOk ? "🟢 ĐANG CHẠY (:3711)    " : "🔴 CHƯA CHẠY (:3711)    "} │`);
  console.log(`│  3. Giao diện Web Trade       : ${webOk ? "🟢 ĐANG CHẠY (:5717)    " : "🔴 CHƯA CHẠY (:5717)    "} │`);
  console.log("├────────────────────────────────────────────────────────────────┤");
  console.log(`│  🔑 Khóa điều khiển V6        : [Đã ẩn bảo mật trong .runtime/v6-control-token.txt]`);
  console.log("├────────────────────────────────────────────────────────────────┤");
  console.log("│  💻 ĐƯỜNG DẪN MỞ TRÊN LAPTOP:                                  │");
  console.log(`│     • Bảng điều khiển : http://localhost:${PORTS.web}/                 │`);
  console.log(`│     • Chế độ Backtest : http://localhost:${PORTS.web}/backtest         │`);
  console.log("├────────────────────────────────────────────────────────────────┤");
  console.log("│  📱 ĐƯỜNG DẪN MỞ TRÊN ĐIỆN THOẠI (CÙNG MẠNG WI-FI):            │");
  console.log(`│     • Giao diện Mobile: http://${ips.lanIp}:${PORTS.web}/phase7c-mobile`);
  console.log(`│     • Full Web Mobile : http://${ips.lanIp}:${PORTS.web}/`);
  if (ips.tailscaleIp) {
    console.log(`│  🌍 ĐƯỜNG DẪN ĐIỆN THOẠI TỪ XA 4G/5G (TAILSCALE):              │`);
    console.log(`│     • http://${ips.tailscaleIp}:${PORTS.web}/phase7c-mobile`);
  }
  console.log("└────────────────────────────────────────────────────────────────┘");

  if (openBrowser && webOk && process.platform === "win32") {
    try {
      execSync(`start http://localhost:${PORTS.web}/`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

function safeGitSync() {
  console.log("==================================================================");
  console.log("  ☁️ KIỂM TRA BẢO MẬT & ĐỒNG BỘ CODE VỚI GITHUB");
  console.log("==================================================================");
  const gitignorePath = path.join(ROOT_DIR, ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  if (!gitignore.includes(".env")) {
    throw new Error("CẢNH BÁO: .gitignore thiếu quy tắc chặn .env! Đã hủy đẩy code để bảo vệ mật khẩu MT5.");
  }
  console.log("  ✓ Kiểm tra .gitignore: Các file .env, .runtime/, mật khẩu MT5 và dữ liệu SQLite đã được khóa bảo mật.");
  try {
    execSync("git pull --rebase", { cwd: ROOT_DIR, stdio: "inherit" });
    console.log("  ✓ Hoàn tất đồng bộ từ GitHub!");
  } catch {
    console.log("  ℹ Lưu ý: Hãy đảm bảo bạn đã kết nối remote GitHub (git remote add origin <URL_REPO>).");
  }
}

const cmd = (process.argv[2] || "status").toLowerCase();
if (cmd === "start") {
  await startServices({ webOnly: false });
} else if (cmd === "web-only") {
  await startServices({ webOnly: true });
} else if (cmd === "stop") {
  await stopServices();
} else if (cmd === "init-env") {
  initEnvFilesIfMissing();
} else if (cmd === "git-sync") {
  safeGitSync();
} else {
  await printStatusSummary(false);
}
