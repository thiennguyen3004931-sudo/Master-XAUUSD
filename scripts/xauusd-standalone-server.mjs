#!/usr/bin/env node
/**
 * XAUUSD AI MASTER — MÁY CHỦ ĐỘC LẬP & ĐIỀU PHỐI GIAO DỊCH TRỰC TIẾP (V6)
 * Kiến trúc An toàn Fail-Closed (P0/P1 Deep Audit Remediation):
 * 1. Khởi động mặc định ở trạng thái PAUSE & DISARMED (liveArmed=false, liveAuthorized=false, autoBotState.enabled=false, positiveDcaConfig.enabled=false).
 * 2. Không tự khôi phục trạng thái Auto/DCA hoặc quyền LIVE sau khi restart.
 * 3. Xác thực API: Không coi IP localhost/LAN là bằng chứng cấp quyền; tắt hoàn toàn cấp token không xác thực qua /api/v1/auth-bootstrap;
 *    hỗ trợ ghép nối thiết bị bằng Mã Ghép Nối 1 Lần (OTP ngắn hạn, khóa sau 5 lần sai) qua POST /api/v1/auth-pair hoặc ZIQ_V6_CONTROL_TOKEN.
 * 4. Tách biệt tuyệt đối Connect Account, Auto Bot, Đặt lệnh tay và ARM LIVE:
 *    - Kết nối tài khoản luôn kết thúc ở PAUSE + DISARMED.
 *    - Bật Auto không tự ARM LIVE; đặt lệnh tay không tự gán cờ LIVE=true.
 *    - Chỉ thao tác POST /api/v1/mt5/arm-live riêng biệt, đã xác thực mới cấp quyền ARM gắn với (sessionId, accountLogin, server).
 *    - Tắt Auto chỉ dừng mở lệnh mới, không ngừng bảo vệ SL cho vị thế đang mở.
 * 5. Loại bỏ dữ liệu mẫu 48 lệnh khỏi kết quả vận hành (hiển thị CHƯA CÓ DỮ LIỆU khi chưa chạy backtest thực tế).
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseRequiredTicket, parseOptionalBoolean } from "./v6-api-input-guards.mjs";
import { getV6ExecutionSizingDisclosure } from "./v6-execution-sizing-disclosure.mjs";
import { getV6BrokerStatusEvidence, readExplicitBacktestStartingBalance } from "./v6-broker-status-evidence.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = process.env.V6_RUNTIME_DIR ? path.resolve(process.env.V6_RUNTIME_DIR) : path.join(ROOT_DIR, ".runtime");

const API_PORT = Number(process.env.API_PORT || 3711);
const WEB_PORT = Number(process.env.WEB_PORT || 5717);

const ACCOUNT_CONFIG_FILE = path.join(RUNTIME_DIR, "active-mt5-account.json");
const LIVE_ARM_FILE = path.join(RUNTIME_DIR, "phase7c-live-arm.json");
const ACCOUNT_MODE_FILE = path.join(RUNTIME_DIR, "phase7c-account-mode.json");
const PAIRING_OTP_INFO_FILE = path.join(RUNTIME_DIR, "v6-pairing-otp.txt");
const DIRECT_PROBE_SCRIPT = path.join(ROOT_DIR, "scripts", "mt5-direct-probe.py");

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// Do not kill unrelated Windows processes to reclaim ports. In particular, a
// self-hosted CI runner and MT5 must never be disrupted by starting this server.
// A port conflict is a fatal startup error, not permission to Stop-Process.

const SERVER_BOOT_SESSION_ID = "boot_" + crypto.randomBytes(12).toString("hex");
const POSITION_MGMT_INTERVAL_MS = 3000;
const SIGNAL_SCAN_INTERVAL_MS = 6000;

// Explicit server alias mapping (never match arbitrary substrings like .includes("dbg"))
const EXPLICIT_SERVER_ALIAS_MAP = new Map([
  ["dbgmarkets-live", "dbgmarkets-live"],
  ["dbg market limited", "dbgmarkets-live"],
  ["dbgmarkets-demo", "dbgmarkets-demo"],
  ["dbg market limited demo", "dbgmarkets-demo"],
]);

export function canonicalServerKey(serverName) {
  const clean = String(serverName || "").trim().toLowerCase();
  if (!clean) return "";
  return EXPLICIT_SERVER_ALIAS_MAP.get(clean) || clean;
}

export function serversMatch(serverA, serverB) {
  const a = canonicalServerKey(serverA);
  const b = canonicalServerKey(serverB);
  return Boolean(a && b && a === b);
}

let customMt5EngineInvokerForTest = null;
export function setMt5EngineInvokerForTest(fn) {
  customMt5EngineInvokerForTest = typeof fn === "function" ? fn : null;
}

// Mặc định khởi động DISARMED (liveArmed: false, explicitLiveGateConfirmed: false)
let currentAccountConfig = {
  ...loadSavedAccountConfig(),
  liveArmed: false,
  explicitLiveGateConfirmed: false,
};

// Nguồn trạng thái ARM duy nhất gắn chặt với phiên vận hành (sessionId), tài khoản (accountLogin) và máy chủ (server)
let liveArmSessionState = {
  armed: false,
  explicitLiveGateConfirmed: false,
  sessionId: SERVER_BOOT_SESSION_ID,
  accountLogin: null,
  server: null,
  armedAt: null,
  armedByDevice: null,
  disarmReason: "Khởi động mặc định ở trạng thái PAUSE + DISARMED",
};

export function disarmLiveSession(reason = "Đã khóa ARM LIVE (DISARMED)") {
  liveArmSessionState = {
    armed: false,
    explicitLiveGateConfirmed: false,
    sessionId: SERVER_BOOT_SESSION_ID,
    accountLogin: null,
    server: null,
    armedAt: null,
    armedByDevice: null,
    disarmReason: reason,
  };
  currentAccountConfig.liveArmed = false;
  currentAccountConfig.explicitLiveGateConfirmed = false;
}

export function armLiveSessionForAccount(login, server, device = "WEB") {
  const cleanLogin = String(login || "").trim();
  const cleanServer = String(server || "").trim();
  if (!cleanLogin || !cleanServer) {
    disarmLiveSession("Thiếu thông tin tài khoản hoặc server khi ARM");
    return false;
  }
  liveArmSessionState = {
    armed: true,
    explicitLiveGateConfirmed: true,
    sessionId: SERVER_BOOT_SESSION_ID,
    accountLogin: cleanLogin,
    server: cleanServer,
    armedAt: Date.now(),
    armedByDevice: device,
    disarmReason: null,
  };
  currentAccountConfig.liveArmed = true;
  currentAccountConfig.explicitLiveGateConfirmed = true;
  return true;
}

function atomicWriteFileSync(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, targetPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

export function validateFixedLotAgainstBroker(lotVal, brokerSpecs = null) {
  if (lotVal === null || lotVal === undefined || typeof lotVal === "boolean" || String(lotVal).trim() === "") {
    return { ok: false, error: "INVALID_FIXED_LOT", message: "Fixed Lot không được để trống hoặc kiểu boolean." };
  }
  const num = typeof lotVal === "number" ? lotVal : Number(String(lotVal).trim());
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: "INVALID_FIXED_LOT", message: "Fixed Lot phải là số hữu hạn dương (> 0)." };
  }
  if (num < 0.0001) {
    return { ok: false, error: "INVALID_FIXED_LOT", message: "Fixed Lot dưới mức tối thiểu kỹ thuật (0.0001) — bị từ chối." };
  }
  if (brokerSpecs) {
    const vMin = Number(brokerSpecs.volumeMin ?? brokerSpecs.volume_min);
    const vMax = Number(brokerSpecs.volumeMax ?? brokerSpecs.volume_max);
    const vStep = Number(brokerSpecs.volumeStep ?? brokerSpecs.volume_step);
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax) || !Number.isFinite(vStep) || vMin <= 0 || vStep <= 0 || vMax < vMin) {
      return { ok: false, error: "MISSING_BROKER_LOT_SPECS", message: "Thiếu thông số volume_min/max/step hợp lệ từ broker — từ chối giao dịch mới." };
    }
    if (num < vMin - 1e-12 || num > vMax + 1e-12) {
      return { ok: false, error: "LOT_OUT_OF_BROKER_BOUNDS", message: `Fixed Lot (${num}) nằm ngoài giới hạn broker [${vMin}, ${vMax}].` };
    }
    const steps = num / vStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return { ok: false, error: "LOT_INVALID_BROKER_STEP", message: `Fixed Lot (${num}) không khớp bước khối lượng broker (step=${vStep}).` };
    }
  }
  return { ok: true, fixedLot: num };
}

export let configIntegrityState = {
  verified: true,
  error: null,
  message: null,
};

export function getConfigIntegrityState() {
  return { ...configIntegrityState };
}

export function getCanonicalFixedLot() {
  if (currentAccountConfig.configUnverified === true && currentAccountConfig.fixedLot === null) {
    return null;
  }
  const raw = currentAccountConfig.fixedLot !== undefined ? currentAccountConfig.fixedLot : autoBotState.volume;
  if (raw === undefined || raw === null) return 0.02;
  const check = validateFixedLotAgainstBroker(raw);
  return check.ok ? check.fixedLot : null;
}

export function setCanonicalFixedLot(lotVal, persist = true, brokerSpecs = null) {
  const check = validateFixedLotAgainstBroker(lotVal, brokerSpecs);
  if (!check.ok) return check;
  const cleanLot = check.fixedLot;
  const prevCfgLot = currentAccountConfig.fixedLot;
  const prevBotLot = autoBotState.volume;
  const prevAcctDisk = fs.existsSync(ACCOUNT_CONFIG_FILE) ? fs.readFileSync(ACCOUNT_CONFIG_FILE, "utf8") : null;
  const prevSharedDisk = fs.existsSync(SHARED_STATE_FILE) ? fs.readFileSync(SHARED_STATE_FILE, "utf8") : null;

  currentAccountConfig.fixedLot = cleanLot;
  autoBotState.volume = cleanLot;
  if (persist) {
    try {
      saveAccountConfig(currentAccountConfig);
      atomicWriteFileSync(
        SHARED_STATE_FILE,
        JSON.stringify({ syncRevision, lastSyncAction, autoBotState: { ...autoBotState, enabled: false }, positiveDcaConfig: { ...positiveDcaConfig, enabled: false }, strategyProposals }, null, 2)
      );
    } catch (err) {
      currentAccountConfig.fixedLot = prevCfgLot;
      autoBotState.volume = prevBotLot;
      const rollbackErrors = [];
      try {
        const curAcctDisk = fs.existsSync(ACCOUNT_CONFIG_FILE) ? fs.readFileSync(ACCOUNT_CONFIG_FILE, "utf8") : null;
        if (curAcctDisk !== prevAcctDisk) {
          if (prevAcctDisk !== null) {
            atomicWriteFileSync(ACCOUNT_CONFIG_FILE, prevAcctDisk);
            const verifyAcct = fs.readFileSync(ACCOUNT_CONFIG_FILE, "utf8");
            if (verifyAcct !== prevAcctDisk) rollbackErrors.push("ACCOUNT_CONFIG_MISMATCH_AFTER_ROLLBACK");
          } else if (fs.existsSync(ACCOUNT_CONFIG_FILE)) {
            fs.unlinkSync(ACCOUNT_CONFIG_FILE);
          }
        }
      } catch (rbErr1) {
        rollbackErrors.push(`ACCOUNT_ROLLBACK_ERR: ${rbErr1?.message || "failed"}`);
      }
      try {
        const curSharedDisk = fs.existsSync(SHARED_STATE_FILE) ? fs.readFileSync(SHARED_STATE_FILE, "utf8") : null;
        if (curSharedDisk !== prevSharedDisk) {
          if (prevSharedDisk !== null) {
            atomicWriteFileSync(SHARED_STATE_FILE, prevSharedDisk);
            const verifyShared = fs.readFileSync(SHARED_STATE_FILE, "utf8");
            if (verifyShared !== prevSharedDisk) rollbackErrors.push("SHARED_STATE_MISMATCH_AFTER_ROLLBACK");
          } else if (fs.existsSync(SHARED_STATE_FILE)) {
            fs.unlinkSync(SHARED_STATE_FILE);
          }
        }
      } catch (rbErr2) {
        rollbackErrors.push(`SHARED_ROLLBACK_ERR: ${rbErr2?.message || "failed"}`);
      }
      if (rollbackErrors.length > 0) {
        configIntegrityState = {
          verified: false,
          error: "CRITICAL_ROLLBACK_FAILED",
          message: `Cấu hình trên đĩa không đồng nhất sau lỗi ghi và hoàn tác thất bại (${rollbackErrors.join("; ")}) — tạm chặn mở lệnh mới.`,
        };
        currentAccountConfig.configUnverified = true;
        return {
          ok: false,
          error: "CRITICAL_ROLLBACK_FAILED",
          rollbackVerified: false,
          rollbackErrors,
          message: `LỖI NGHIÊM TRỌNG: Ghi cấu hình thất bại (${err?.message}) và hoàn tác KHÔNG thành công (${rollbackErrors.join("; ")}).`,
        };
      }
      return {
        ok: false,
        error: "CONFIG_PERSIST_FAILED",
        rollbackVerified: true,
        message: `Không thể lưu đồng bộ cấu hình Fixed Lot xuống đĩa (đã xác minh hoàn tác trên đĩa): ${err?.message || "IO error"}`,
      };
    }
  }
  configIntegrityState = { verified: true, error: null, message: null };
  currentAccountConfig.configUnverified = false;
  return { ok: true, fixedLot: cleanLot };
}

export function getCanonicalLiveArmState(probeSnapshot = lastDirectProbeSnapshot) {
  if (
    !liveArmSessionState.armed ||
    !liveArmSessionState.explicitLiveGateConfirmed ||
    liveArmSessionState.sessionId !== SERVER_BOOT_SESSION_ID ||
    !liveArmSessionState.accountLogin ||
    !liveArmSessionState.server
  ) {
    return {
      liveArmed: false,
      liveAuthorized: false,
      explicitLiveGateConfirmed: false,
      armedAccountLogin: null,
      armedServer: null,
      sessionId: SERVER_BOOT_SESSION_ID,
      disarmReason: liveArmSessionState.disarmReason || "Chưa thực hiện thao tác ARM LIVE cho phiên này",
    };
  }

  const cfgLogin = String(currentAccountConfig.login || "").trim();
  const cfgServer = String(currentAccountConfig.server || "").trim();
  const sameCfgServer = serversMatch(cfgServer, liveArmSessionState.server);

  if (cfgLogin !== liveArmSessionState.accountLogin || !sameCfgServer) {
    disarmLiveSession("Tài khoản hoặc máy chủ cấu hình đã thay đổi — tự động hủy quyền ARM");
    return {
      liveArmed: false,
      liveAuthorized: false,
      explicitLiveGateConfirmed: false,
      armedAccountLogin: null,
      armedServer: null,
      sessionId: SERVER_BOOT_SESSION_ID,
      disarmReason: liveArmSessionState.disarmReason,
    };
  }

  // An ARM session is never sufficient without a currently connected,
  // identity-verified broker snapshot. Missing/disconnected/stale probe data
  // must fail closed instead of retaining LIVE authorization.
  if (!probeSnapshot || probeSnapshot.connected !== true) {
    disarmLiveSession("Mất hoặc thiếu xác nhận kết nối MT5 — tự động hủy quyền ARM");
    return getCanonicalLiveArmState(null);
  }
  {
    const actualLogin = String(probeSnapshot.accountLogin || "").trim();
    const actualServer = String(probeSnapshot.server || "").trim();
    const actualMode = String(probeSnapshot.accountMode || "").trim().toUpperCase().replace("REAL", "LIVE");
    const configuredMode = String(currentAccountConfig.accountMode || "").trim().toUpperCase().replace("REAL", "LIVE");
    const sameActualServer = Boolean(actualServer) && serversMatch(actualServer, liveArmSessionState.server);
    if (!actualLogin || actualLogin !== liveArmSessionState.accountLogin || !sameActualServer ||
        !actualMode || (configuredMode && actualMode !== configuredMode)) {
      disarmLiveSession(`Tài khoản MT5 thực tế (#${actualLogin}) khác với tài khoản đã ARM (#${liveArmSessionState.accountLogin})`);
      return {
        liveArmed: false,
        liveAuthorized: false,
        explicitLiveGateConfirmed: false,
        armedAccountLogin: null,
        armedServer: null,
        sessionId: SERVER_BOOT_SESSION_ID,
        disarmReason: liveArmSessionState.disarmReason,
      };
    }
  }

  return {
    liveArmed: true,
    liveAuthorized: true,
    explicitLiveGateConfirmed: true,
    armedAccountLogin: liveArmSessionState.accountLogin,
    armedServer: liveArmSessionState.server,
    armedAt: liveArmSessionState.armedAt,
    sessionId: SERVER_BOOT_SESSION_ID,
    disarmReason: null,
  };
}

const IS_MAIN_SERVER_PROCESS = Boolean(process.argv[1] && path.resolve(process.argv[1]) === __filename);
function resolveServerControlToken() {
  const envTok = String(process.env.ZIQ_V6_CONTROL_TOKEN || "").trim();
  if (envTok) return envTok;
  if (IS_MAIN_SERVER_PROCESS) {
    const tokFile = path.join(RUNTIME_DIR, "v6-control-token.txt");
    try {
      if (fs.existsSync(tokFile)) {
        const saved = fs.readFileSync(tokFile, "utf8").trim();
        if (saved.length >= 16) return saved;
      }
    } catch {}
    const fresh = "v6_" + crypto.randomBytes(18).toString("hex");
    try { fs.writeFileSync(tokFile, fresh + "\n", "utf8"); } catch {}
    return fresh;
  }
  return "";
}
const CONTROL_TOKEN = resolveServerControlToken();

// Cơ chế Ghép nối Thiết bị bằng Mã dùng 1 lần (One-Time Pairing Code - OTP) có thời hạn ngắn (Section 1.1)
const pairedDeviceSessions = new Map();
let activePairingOtp = {
  code: "",
  expiresAt: 0,
  used: true,
  failedAttempts: 0,
};

export function issueOneTimePairingCode(ttlMs = 300_000, role = "CONTROL") {
  const randomNum = crypto.randomInt(100000, 999999);
  const code = String(randomNum);
  const expiresAt = Date.now() + Math.max(10_000, Number(ttlMs || 300_000));
  const cleanRole = String(role || "CONTROL").toUpperCase() === "READ_ONLY" ? "READ_ONLY" : "CONTROL";
  activePairingOtp = {
    code,
    expiresAt,
    used: false,
    failedAttempts: 0,
    role: cleanRole,
  };
  if (IS_MAIN_SERVER_PROCESS) {
    try {
      fs.writeFileSync(
        PAIRING_OTP_INFO_FILE,
        [
          "=== MA GHEP NOI THIET BI 1 LAN (ONE-TIME PAIRING CODE) ===",
          `MA OTP (6 SO) : ${code}`,
          ` HIEU LUC DEN : ${new Date(expiresAt).toLocaleTimeString("vi-VN")} (Chi dung 1 lan)`,
          "Huong dan: Nhap ma 6 so nay vao o [Ghep noi Thiet bi / Xac thuc V6] tren giao dien Web PC hoac Dien thoai.",
        ].join("\n") + "\n",
        "utf8"
      );
    } catch {}
  }
  return { code, expiresAt };
}

if (IS_MAIN_SERVER_PROCESS) {
  issueOneTimePairingCode(600_000);
}

export function verifyOneTimePairingCodeAndCreateSession(suppliedCode, deviceName = "WEB_CLIENT") {
  const cleanSupplied = String(suppliedCode || "").trim();
  if (!cleanSupplied) {
    return { ok: false, status: 400, error: "PAIRING_CODE_REQUIRED", message: "Vui lòng nhập Mã ghép nối 1 lần (OTP)." };
  }
  if (
    !activePairingOtp.code ||
    activePairingOtp.used ||
    Date.now() > activePairingOtp.expiresAt ||
    activePairingOtp.failedAttempts >= 5
  ) {
    return {
      ok: false,
      status: 401,
      error: "PAIRING_CODE_EXPIRED_OR_USED",
      message: "Mã ghép nối 1 lần đã hết hạn, đã được sử dụng hoặc bị khóa (quá 5 lần thử sai).",
    };
  }
  const matched = verifyControlTokenHeader(cleanSupplied, activePairingOtp.code);
  if (!matched) {
    activePairingOtp.failedAttempts += 1;
    if (activePairingOtp.failedAttempts >= 5) {
      activePairingOtp.used = true;
    }
    return {
      ok: false,
      status: 401,
      error: "PAIRING_CODE_INVALID",
      message: `Mã ghép nối không đúng (Còn ${Math.max(0, 5 - activePairingOtp.failedAttempts)} lần thử).`,
    };
  }

  // Đánh dấu mã OTP đã dùng ngay lập tức (chỉ dùng 1 lần duy nhất)
  activePairingOtp.used = true;
  activePairingOtp.code = "";
  const sessionToken = "v6_sess_" + crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + 12 * 3600 * 1000;
  const sessionRole = activePairingOtp.role === "READ_ONLY" ? "READ_ONLY" : "CONTROL";
  pairedDeviceSessions.set(sessionToken, {
    deviceName: String(deviceName || "WEB_CLIENT").slice(0, 64),
    role: sessionRole,
    pairedAt: Date.now(),
    expiresAt,
  });
  return {
    ok: true,
    status: 200,
    sessionToken,
    role: sessionRole,
    expiresAt,
    deviceName: String(deviceName || "WEB_CLIENT").slice(0, 64),
  };
}

const ENTRY_DEDUPE_FILE = path.join(RUNTIME_DIR, "v6-entry-dedupe.json");
let previousEntryKey = "";
try { previousEntryKey = JSON.parse(fs.readFileSync(ENTRY_DEDUPE_FILE, "utf8")).key || ""; } catch {}
function persistEntryKey(key) {
  previousEntryKey = key;
  fs.writeFileSync(ENTRY_DEDUPE_FILE, JSON.stringify({ key, timestamp: Date.now() }), "utf8");
}

export function verifyControlTokenHeader(suppliedHeader, expectedToken = CONTROL_TOKEN) {
  const cleanExpected = String(expectedToken || "").trim();
  const cleanSupplied = String(suppliedHeader || "").trim();
  if (!cleanExpected || !cleanSupplied) return false;
  const supplied = Buffer.from(cleanSupplied, "utf8");
  const expected = Buffer.from(cleanExpected, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

const seenReplayNonces = new Map();
const REPLAY_WINDOW_MS = 300_000;

export function verifyReplayGuard(req) {
  const rawNonce = String(req?.headers?.["x-v6-nonce"] || "").trim();
  const rawTs = String(req?.headers?.["x-v6-timestamp"] || "").trim();
  const strictReplay = String(process.env.V6_STRICT_REPLAY_GUARD || "").trim() === "true";
  if (!rawNonce && !rawTs) {
    if (strictReplay && req?.method === "POST") {
      return { ok: false, status: 400, error: "REPLAY_HEADERS_REQUIRED", message: "Thiếu x-v6-nonce hoặc x-v6-timestamp cho thao tác điều khiển." };
    }
    return { ok: true };
  }
  if (!rawNonce || !rawTs) {
    return { ok: false, status: 400, error: "REPLAY_HEADERS_INCOMPLETE", message: "Phải cung cấp cả x-v6-nonce và x-v6-timestamp." };
  }
  const tsNum = Number(rawTs);
  const now = Date.now();
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, error: "REQUEST_TIMESTAMP_EXPIRED", message: "Timestamp yêu cầu điều khiển đã hết hạn hoặc lệch quá 300 giây." };
  }
  for (const [k, exp] of seenReplayNonces.entries()) {
    if (now > exp) seenReplayNonces.delete(k);
  }
  if (seenReplayNonces.has(rawNonce)) {
    return { ok: false, status: 409, error: "REPLAY_DETECTED", message: "Từ chối request lặp lại (replay nonce đã được sử dụng)." };
  }
  seenReplayNonces.set(rawNonce, now + REPLAY_WINDOW_MS * 2);
  return { ok: true };
}

export function resolveAuthRole(req, tokenOverride = undefined) {
  const suppliedHeader = String(req?.headers?.["x-v6-control-token"] || "").trim();
  if (!suppliedHeader) return null;

  if (tokenOverride !== undefined) {
    const activeToken = String(tokenOverride || "").trim();
    if (!activeToken) return null;
    return verifyControlTokenHeader(suppliedHeader, activeToken) ? "CONTROL" : null;
  }

  if (CONTROL_TOKEN && verifyControlTokenHeader(suppliedHeader, CONTROL_TOKEN)) {
    return "CONTROL";
  }

  const readOnlyTok = String(process.env.ZIQ_V6_READONLY_TOKEN || "").trim();
  if (readOnlyTok && verifyControlTokenHeader(suppliedHeader, readOnlyTok)) {
    return "READ_ONLY";
  }

  const now = Date.now();
  for (const [sessTok, meta] of pairedDeviceSessions.entries()) {
    if (now > meta.expiresAt) {
      pairedDeviceSessions.delete(sessTok);
      continue;
    }
    if (verifyControlTokenHeader(suppliedHeader, sessTok)) {
      return meta.role === "READ_ONLY" ? "READ_ONLY" : "CONTROL";
    }
  }
  return null;
}

export function readAuthorized(req, tokenOverride = undefined) {
  const role = resolveAuthRole(req, tokenOverride);
  return role === "CONTROL" || role === "READ_ONLY";
}

export function controlAuthorized(req, tokenOverride = undefined) {
  return resolveAuthRole(req, tokenOverride) === "CONTROL";
}

let positiveDcaConfig = {
  enabled: false,
  maxLayers: 2,
  stepDistance: 4.5,
  lotMultiplier: 0.5,
  slDistance: 6.8,
  tpDistance: 16.0,
  autoBreakEvenBeforeAdd: true,
  lastDcaTime: 0,
  lastStatusText: "Chế độ DCA Dương đang TẮT (Khởi động mặc định ở trạng thái an toàn DISARMED).",
};

let trendManagementConfig = {
  slMode: "STRUCTURAL_6_8",
  structuralSlMin: 6.0,
  structuralSlMax: 8.0,
  beAtOneR: true,
  beTriggerRMultiple: 1.0,
  beBufferPts: 0.25,
  beCompensateCost: true,
  enableM5StructuralTrail: true,
  m15SpikeTrailDist: 10.0,
  enablePartialCloseAtSr: false,
  semiAutoAdoptManual: false,
  positionManagementEnabled: true,
};

let autoBotState = {
  enabled: false,
  strategyMode: "PAUSE",
  configuredStrategyMode: "AUTO_REGIME",
  volume: 0.02,
  slDistance: 6.8,
  tpDistance: 16.0,
  minConfidence: 85,
  lastActionTime: 0,
  lastLog: "Hệ thống khởi động ở trạng thái PAUSE & DISARMED (liveArmed=false, autoBot=false, DCA=false).",
};

let internetTunnelState = {
  active: false,
  publicUrl: null,
  provider: null,
  statusText: "Chưa bật đường hầm Internet 4G/5G (Đang dùng mạng nội bộ Wi-Fi / LAN).",
};

// Section 4.1: Không dùng 48 lệnh mẫu hoặc số liệu hard-code để kết luận hiệu quả vận hành.
// Khi chưa chạy backtest thực tế từ dữ liệu giá MT5, hiển thị rõ CHƯA CÓ DỮ LIỆU.
let lastVerifiedBacktestResult = null;
let botSampleStats = [
  {
    botId: "AUTO_REGIME",
    botName: "1. Tự Động Theo Trạng Thái Thị Trường (Phân loại Trend / Range / Transition)",
    dataStatus: "CHƯA CÓ DỮ LIỆU",
    isSimulatedSampleData: false,
    dcaEvaluationStatus: "CHƯA ĐÁNH GIÁ DCA",
    sampleSize: 0,
    wins: null,
    breakevens: null,
    losses: null,
    winRatePercent: null,
    breakevenRatePercent: null,
    lossRatePercent: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdownPct: null,
    maxConsecutiveLosses: null,
    netPnlUsd: null,
    recommended: false,
    note: "CHƯA CÓ DỮ LIỆU: Bấm [Chạy Backtest từ dữ liệu giá MT5] để đánh giá thực tế (Phân loại TREND_UP/TREND_DOWN/RANGE/TRANSITION/UNKNOWN -> Kiểm tra SL 6–8 giá & cản gần H1/H4).",
  },
  {
    botId: "SEMI_AUTO_TREND",
    botName: "2. Bán Tự Động (Vào lệnh tay — Tự quản lý SL Cấu Trúc M5, BE 1R & Cực trị 10 giá)",
    dataStatus: "CHƯA CÓ DỮ LIỆU",
    isSimulatedSampleData: false,
    dcaEvaluationStatus: "CHƯA ĐÁNH GIÁ DCA",
    sampleSize: 0,
    wins: null,
    breakevens: null,
    losses: null,
    winRatePercent: null,
    breakevenRatePercent: null,
    lossRatePercent: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdownPct: null,
    maxConsecutiveLosses: null,
    netPnlUsd: null,
    recommended: false,
    note: "CHƯA CÓ DỮ LIỆU: Quản lý vị thế vào tay theo bộ quản lý lệnh dùng chung (initialR cố định, BE tại 1R có bù phí, Trailing M5 đóng nến trước/sau BE, Khóa cực trị 10 giá).",
  },
  {
    botId: "BOT_1_TREND",
    botName: "3. Bot Thuận Xu Hướng & Quét Thanh Khoản (EMA10/25/34 H4·H1·M15 + Nến M5 xác nhận)",
    dataStatus: "CHƯA CÓ DỮ LIỆU",
    isSimulatedSampleData: false,
    dcaEvaluationStatus: "CHƯA ĐÁNH GIÁ DCA",
    sampleSize: 0,
    wins: null,
    breakevens: null,
    losses: null,
    winRatePercent: null,
    breakevenRatePercent: null,
    lossRatePercent: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdownPct: null,
    maxConsecutiveLosses: null,
    netPnlUsd: null,
    recommended: false,
    note: "CHƯA CÓ DỮ LIỆU: Kiểm tra đồng pha EMA10/25/34 trên H4/H1/M15 + nến M5 xác nhận; SL cấu trúc 8 nến M5 (6–8 giá); kiểm tra cản gần H1/H4 đủ R:R >= 1.6 sau phí.",
  },
  {
    botId: "BOT_2_SIDEWAY",
    botName: "4. Bot Giao Dịch Biên Độ Ngang (Biên hộp 20 nến M15 khi H1 phẳng · Tắt DCA)",
    dataStatus: "CHƯA CÓ DỮ LIỆU",
    isSimulatedSampleData: false,
    dcaEvaluationStatus: "KHÔNG ÁP DỤNG DCA (SIDEWAY)",
    sampleSize: 0,
    wins: null,
    breakevens: null,
    losses: null,
    winRatePercent: null,
    breakevenRatePercent: null,
    lossRatePercent: null,
    profitFactor: null,
    expectancyR: null,
    maxDrawdownPct: null,
    maxConsecutiveLosses: null,
    netPnlUsd: null,
    recommended: false,
    note: "CHƯA CÓ DỮ LIỆU: Chỉ vào lệnh tại 30% rìa biên hộp 20 nến M15 khi EMA10/25 H1 phẳng, đặt TP trước biên đối diện có đệm (R:R >= 1.25 sau phí).",
  },
];

let strategyProposals = [
  {
    id: "PROP-04",
    title: "Cấu hình #1: Tự Động Theo Trạng Thái Thị Trường (AUTO_REGIME · Phân loại 5 trạng thái)",
    targetBot: "1. Tự Động Theo Trạng Thái Thị Trường (AUTO_REGIME)",
    sampleEvidence: "CHƯA CÓ DỮ LIỆU KIỂM CHỨNG TRÊN MT5 — Cần chạy Backtest trên dữ liệu nến thực tế (In-Sample / Validation / Out-of-Sample).",
    proposedChanges: "Phân loại TREND_UP / TREND_DOWN / RANGE / TRANSITION / UNKNOWN trước khi chọn chiến lược · SL 6–8 giá · BE tại 1R · Trailing M5 trước & sau BE · Khóa cực trị 10 giá.",
    riskImpact: "Giới hạn rủi ro tối đa 1.0% Equity/lệnh, 1.5% tổng danh mục và chặn lỗ ngày từ lịch sử deal MT5.",
    status: "PENDING",
    decidedAt: null,
  },
  {
    id: "PROP-01",
    title: "Cấu hình #2: Bot Thuận Xu Hướng & Quét Thanh Khoản (BOT_1_TREND)",
    targetBot: "3. Bot Thuận Xu Hướng & Quét Thanh Khoản",
    sampleEvidence: "CHƯA CÓ DỮ LIỆU KIỂM CHỨNG TRÊN MT5 — Cần chạy Backtest trên dữ liệu nến thực tế.",
    proposedChanges: "Chọn cấu hình BOT_1_TREND (EMA10/25/34 H4·H1·M15 + M5 xác nhận) · Kiểm tra cản gần H1/H4 đủ R:R >= 1.6 sau phí.",
    riskImpact: "Không tự động ARM LIVE khi bật Auto hoặc đổi cấu hình.",
    status: "PENDING",
    decidedAt: null,
  },
  {
    id: "PROP-02",
    title: "Cấu hình #3: Bán Tự Động (SEMI_AUTO_TREND — Quản lý SL bảo vệ cho lệnh vào tay)",
    targetBot: "2. Bán Tự Động (Quản lý lệnh vào tay)",
    sampleEvidence: "CHƯA CÓ DỮ LIỆU KIỂM CHỨNG TRÊN MT5 — Cần chạy Backtest trên dữ liệu nến thực tế.",
    proposedChanges: "Chọn cấu hình SEMI_AUTO_TREND · Lưu bền vững initialR · Nâng SL theo cấu trúc M5 đã đóng (trước & sau BE) và khóa cực trị 10 giá · Giữ nguyên TP.",
    riskImpact: "Chỉ nâng SL bảo vệ đơn điệu, tuyệt đối không nới SL hoặc đóng lệnh khi lỗi sửa SL.",
    status: "PENDING",
    decidedAt: null,
  },
  {
    id: "PROP-03",
    title: "Cấu hình #4: Bot Giao Dịch Biên Độ Ngang (BOT_2_SIDEWAY — Khóa DCA Dương)",
    targetBot: "4. Bot Giao Dịch Biên Độ Ngang (Biên hộp 20 nến M15)",
    sampleEvidence: "CHƯA CÓ DỮ LIỆU KIỂM CHỨNG TRÊN MT5 — Cần chạy Backtest trên dữ liệu nến thực tế.",
    proposedChanges: "Chọn cấu hình BOT_2_SIDEWAY · Tự động tắt DCA Dương · TP đặt trước biên đối diện hộp 20 nến M15 (R:R >= 1.25 sau phí).",
    riskImpact: "Tuân thủ cổng rủi ro chung 1.0% / 1.5% và kiểm tra SL 6–8 giá trước khi gửi lệnh.",
    status: "PENDING",
    decidedAt: null,
  },
];

const TELEGRAM_CONFIG_FILE = path.join(RUNTIME_DIR, "telegram-config.json");
const SHARED_STATE_FILE = path.join(RUNTIME_DIR, "shared-bot-state.json");

export function restoreSafeConfigFromSavedState(saved) {
  const allowedModes = new Set([
    "AUTO_REGIME", "SEMI_AUTO_TREND", "BOT_1_TREND", "BOT_2_SIDEWAY",
    "BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS", "LIQUIDITY_SWEEP_AND_TREND"
  ]);
  const oldBot = saved?.autoBotState || {};
  const oldDca = saved?.positiveDcaConfig || {};
  if (allowedModes.has(oldBot.strategyMode)) {
    autoBotState.configuredStrategyMode = oldBot.strategyMode;
  } else if (allowedModes.has(oldBot.configuredStrategyMode)) {
    autoBotState.configuredStrategyMode = oldBot.configuredStrategyMode;
  }
  for (const field of ["slDistance", "tpDistance", "minConfidence"]) {
    if (Number.isFinite(Number(oldBot[field])) && Number(oldBot[field]) > 0) {
      autoBotState[field] = Number(oldBot[field]);
    }
  }
  if (currentAccountConfig.configUnverified === true) {
    configIntegrityState = {
      verified: false,
      error: configIntegrityState.error || "CORRUPTED_ACCOUNT_CONFIG",
      message: configIntegrityState.message || "File cấu hình active-mt5-account.json bị hỏng hoặc chứa Fixed Lot không hợp lệ — tạm chặn mở lệnh mới.",
    };
    autoBotState.volume = null;
  } else if (oldBot.volume !== undefined && !validateFixedLotAgainstBroker(oldBot.volume).ok && !validateFixedLotAgainstBroker(currentAccountConfig.fixedLot).ok) {
    configIntegrityState = {
      verified: false,
      error: "CORRUPTED_LOT_CONFIG",
      message: "Cả hai nguồn cấu hình Fixed Lot đều không hợp lệ — không tự chọn lot mặc định 0.02, tạm chặn mở lệnh mới.",
    };
    currentAccountConfig.configUnverified = true;
    currentAccountConfig.fixedLot = null;
    autoBotState.volume = null;
  } else {
    const acctLotCheck = validateFixedLotAgainstBroker(currentAccountConfig.fixedLot);
    const botLotCheck = validateFixedLotAgainstBroker(oldBot.volume);
    const reconciledLot = acctLotCheck.ok ? acctLotCheck.fixedLot : (botLotCheck.ok ? botLotCheck.fixedLot : 0.02);
    currentAccountConfig.fixedLot = reconciledLot;
    autoBotState.volume = reconciledLot;
    configIntegrityState = { verified: true, error: null, message: null };
    currentAccountConfig.configUnverified = false;
  }
  autoBotState.slDistance = Math.max(6.0, Math.min(8.0, Number(autoBotState.slDistance || 6.8)));
  if (Number.isInteger(Number(oldDca.maxLayers)) && Number(oldDca.maxLayers) >= 1 && Number(oldDca.maxLayers) <= 3) {
    positiveDcaConfig.maxLayers = Number(oldDca.maxLayers);
  }
  if (Number.isFinite(Number(oldDca.stepDistance)) && Number(oldDca.stepDistance) > 0) {
    positiveDcaConfig.stepDistance = Number(oldDca.stepDistance);
  }
  if (Number.isFinite(Number(oldDca.lotMultiplier)) && Number(oldDca.lotMultiplier) > 0 && Number(oldDca.lotMultiplier) <= 1) {
    positiveDcaConfig.lotMultiplier = Number(oldDca.lotMultiplier);
  }
  // HARD SAFETY REQUIREMENT (P0): Never restore enabled=true or liveArmed=true across restarts!
  autoBotState.enabled = false;
  autoBotState.strategyMode = "PAUSE";
  positiveDcaConfig.enabled = false;
  trendManagementConfig.enablePartialCloseAtSr = false;
  trendManagementConfig.semiAutoAdoptManual = false;
  trendManagementConfig.positionManagementEnabled = true;
  disarmLiveSession("Khởi động lại hệ thống — tự động thu hồi quyền ARM LIVE");
}

export function reloadRuntimeConfigFromDisk() {
  const loadedAcct = loadSavedAccountConfig();
  currentAccountConfig = {
    ...loadedAcct,
    liveArmed: false,
    explicitLiveGateConfirmed: false,
  };
  if (fs.existsSync(SHARED_STATE_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, "utf8"));
      restoreSafeConfigFromSavedState(saved);
    } catch (err) {
      restoreSafeConfigFromSavedState({});
      configIntegrityState = {
        verified: false,
        error: "CORRUPTED_SHARED_STATE",
        message: `File trạng thái shared-bot-state.json bị hỏng (${err?.message || "JSON parse error"}) — tạm chặn mở lệnh mới cho đến khi khôi phục cấu hình.`,
      };
      currentAccountConfig.configUnverified = true;
      currentAccountConfig.fixedLot = null;
      autoBotState.volume = null;
    }
  } else {
    restoreSafeConfigFromSavedState({});
  }
  return getConfigIntegrityState();
}

reloadRuntimeConfigFromDisk();
autoBotState.volume = getCanonicalFixedLot();
autoBotState.lastActionTime = 0;
positiveDcaConfig.lastDcaTime = 0;

let syncRevision = 1;
let lastSyncAction = {
  revision: 1,
  device: "SYSTEM",
  summary: "Khởi tạo V6 ở trạng thái an toàn PAUSE & DISARMED (liveArmed=false, autoBot=false, DCA=false)",
  timestamp: Date.now(),
};

// MÃ HÓA BẢO MẬT AES-256-GCM CHO TELEGRAM BOT TOKEN (KHÔNG LƯU VĂN BẢN THUẦN TRONG MÃ NGUỒN HOẶC FILE CẤU HÌNH)
const TG_VAULT_KEY = crypto.scryptSync(
  String(process.env.ZIQ_TG_MASTER_SECRET || "XAUUSD_V6_MASTER_VAULT_KEY_2026"),
  "DBG_5201362_SALT",
  32
);
const DEFAULT_ENCRYPTED_TG_TOKEN = "";

function encryptTelegramSecret(plainText) {
  const clean = String(plainText || "").trim();
  if (!clean) return "";
  if (clean.startsWith("AES256GCM:")) return clean;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", TG_VAULT_KEY, iv);
  const enc = Buffer.concat([cipher.update(clean, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `AES256GCM:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptTelegramSecret(cipherText) {
  const raw = String(cipherText || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("AES256GCM:")) return raw;
  try {
    const parts = raw.split(":");
    if (parts.length !== 4) return "";
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const enc = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", TG_VAULT_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function loadTelegramConfig() {
  try {
    if (fs.existsSync(TELEGRAM_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_FILE, "utf8"));
      if (saved) {
        const decTok = decryptTelegramSecret(saved.encryptedBotToken || saved.botToken || DEFAULT_ENCRYPTED_TG_TOKEN);
        return {
          enabled: saved.enabled ?? true,
          botToken: decTok,
          encryptedBotToken: encryptTelegramSecret(decTok),
          chatId: saved.chatId || process.env.ZIQ_TELEGRAM_CHAT_ID || "",
          notifyOrders: saved.notifyOrders ?? true,
          notifyMtf15m: saved.notifyMtf15m ?? false,
          lastSentAt: saved.lastSentAt || null,
          lastStatus: saved.lastStatus || "✓ Đã kích hoạt mã hóa bảo mật AES-256-GCM cho Telegram Token.",
        };
      }
    }
  } catch {}
  const defaultDec = decryptTelegramSecret(process.env.ZIQ_TELEGRAM_BOT_TOKEN || DEFAULT_ENCRYPTED_TG_TOKEN);
  return {
    enabled: Boolean(defaultDec),
    botToken: defaultDec,
    encryptedBotToken: encryptTelegramSecret(defaultDec),
    chatId: process.env.ZIQ_TELEGRAM_CHAT_ID || "",
    notifyOrders: true,
    notifyMtf15m: false,
    lastSentAt: null,
    lastStatus: "✓ Đã mã hóa bảo mật AES-256-GCM cho Telegram Bot Token.",
  };
}

let telegramConfig = loadTelegramConfig();

function saveTelegramConfig(cfg) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const encTok = encryptTelegramSecret(cfg.botToken || cfg.encryptedBotToken || DEFAULT_ENCRYPTED_TG_TOKEN);
    const diskPayload = {
      enabled: Boolean(cfg.enabled ?? true),
      encryptedBotToken: encTok,
      encryptionAlgorithm: "AES-256-GCM",
      chatId: String(cfg.chatId || ""),
      notifyOrders: Boolean(cfg.notifyOrders ?? true),
      notifyMtf15m: Boolean(cfg.notifyMtf15m ?? false),
      lastSentAt: cfg.lastSentAt || null,
      lastStatus: cfg.lastStatus || "✓ Đã lưu & mã hóa AES-256-GCM.",
    };
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(diskPayload, null, 2), "utf8");
  } catch {}
}

const BOT_MODE_NAMES = {
  PAUSE: "0. Tạm dừng mở lệnh mới (PAUSE · Vẫn bảo vệ SL vị thế đang mở)",
  AUTO_REGIME: "1. Tự Động Theo Trạng Thái Thị Trường (Trend / Range / Transition)",
  SEMI_AUTO_TREND: "2. Bán Tự Động (Vào lệnh tay — Bot tự quản lý SL Cấu Trúc)",
  BOT_1_TREND: "3. Bot Thuận Xu Hướng & Quét Thanh Khoản (EMA10/25/34 H4·H1·M15 + M5)",
  BOT_2_SIDEWAY: "4. Bot Giao Dịch Biên Độ Ngang (Biên hộp 20 nến M15 · Tắt DCA)",
  BOT_3_SWEEP: "5. Bot Quét Thanh Khoản Đơn Lệnh (Quét 8 nến M15 + xác nhận M5)",
  BOT_4_SWEEP_DCA_PLUS: "6. Bot Quét Thanh Khoản + DCA Dương Sau BE",
};

function getActiveBotDisplayName() {
  return BOT_MODE_NAMES[autoBotState.strategyMode] || autoBotState.strategyMode || "Bot Tự Động Theo Trạng Thái Thị Trường V6";
}

let knownClosedTickets = new Set();
let trackedOpenPositionsMap = new Map();

function formatOrderEntryTelegramMsg(orderRes, accountLogin, balance) {
  const sideIcon = orderRes.side === "BUY" ? "🟢" : "🔴";
  const riskUsd = ((orderRes.slDistance || 6.8) * (orderRes.volume || 0.05) * 100).toFixed(2);
  const rewardUsd = ((orderRes.tpDistance || 15.0) * (orderRes.volume || 0.05) * 100).toFixed(2);
  return [
    `${sideIcon} <b>[VÀO LỆNH MỚI] ${orderRes.side} ${Number(orderRes.volume).toFixed(2)} LOT ${orderRes.symbol} (#${orderRes.ticket || "MT5"})</b>`,
    `🤖 <b>Bot thực thi:</b> ${orderRes.botName || getActiveBotDisplayName()}`,
    `📌 <b>Lý do vào lệnh:</b> ${orderRes.entryReason || "Đồng thuận cấu trúc xu hướng H4/H1 & tín hiệu nến M15"}`,
    `📍 <b>Giá vào (Entry):</b> <b>${Number(orderRes.fillPrice).toFixed(2)}</b>`,
    `🛡 <b>Stoploss (SL):</b> <b>${Number(orderRes.sl).toFixed(2)}</b> (${orderRes.slReason || "Theo cấu trúc 6–8 giá"})`,
    `🎯 <b>Take Profit (TP):</b> <b>${Number(orderRes.tp).toFixed(2)}</b> (${orderRes.tpReason || "Đã kiểm tra cản gần H1/H4"})`,
    `📌 <b>Cơ chế giữ lệnh:</b> Lưu cố định initialR · Nâng SL theo đáy/đỉnh M5 đã đóng (trước & sau BE) · Đạt 1R kéo BE · Khóa cực trị M15 cách 10 giá`,
    `💰 <b>Lãi/Lỗ hiện tại:</b> $0.00 USD (Rủi ro 1R: -$${riskUsd} | Kỳ vọng TP: +$${rewardUsd} | Số dư TK #${accountLogin}: $${balance})`,
  ].join("\n");
}

function sendTelegramNotification(htmlText) {
  return new Promise((resolve) => {
    const token = String(telegramConfig.botToken || "").trim();
    const chatId = String(telegramConfig.chatId || "").trim();
    if (!token || !chatId || token.includes("REPLACE_WITH")) {
      resolve({ ok: false, message: "Chưa cấu hình Telegram Bot Token hoặc Chat ID hợp lệ." });
      return;
    }
    const payload = JSON.stringify({
      chat_id: chatId,
      text: htmlText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.ok) {
              telegramConfig.lastSentAt = Date.now();
              telegramConfig.lastStatus = `✓ Đã gửi thông báo tới Telegram (${chatId}) lúc ${new Date().toLocaleTimeString("vi-VN")}`;
              saveTelegramConfig(telegramConfig);
              resolve({ ok: true, message: telegramConfig.lastStatus });
            } else {
              const errDesc = parsed?.description || `HTTP ${res.statusCode}`;
              telegramConfig.lastStatus = `Lỗi Telegram: ${errDesc}`;
              resolve({ ok: false, message: telegramConfig.lastStatus });
            }
          } catch {
            resolve({ ok: false, message: "Lỗi phân tích phản hồi từ Telegram API." });
          }
        });
      }
    );
    req.on("error", (e) => {
      telegramConfig.lastStatus = `Lỗi kết nối Telegram: ${e.message}`;
      resolve({ ok: false, message: telegramConfig.lastStatus });
    });
    req.write(payload);
    req.end();
  });
}

function recordSyncAction(device, summary) {
  syncRevision += 1;
  lastSyncAction = {
    revision: syncRevision,
    device: device || "WEB",
    summary,
    timestamp: Date.now(),
  };
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const persistedBot = { ...autoBotState, enabled: false };
    const persistedDca = { ...positiveDcaConfig, enabled: false };
    fs.writeFileSync(
      SHARED_STATE_FILE,
      JSON.stringify({ syncRevision, lastSyncAction, autoBotState: persistedBot, positiveDcaConfig: persistedDca, strategyProposals }, null, 2),
      "utf8"
    );
  } catch {}
}

export function buildFallbackMtfAnalysis(_priceVal) {
  const nowSec = Math.floor(Date.now() / 1000);
  const remSec = Math.max(5, (Math.floor(nowSec / 900) + 1) * 900 - nowSec);
  return {
    updatedAt: Date.now(),
    nextUpdateInSec: remSec,
    status: "DATA_UNAVAILABLE",
    waitingForMt5: true,
    allowed: false,
    currentPrice: null,
    marketRegime: "UNKNOWN",
    h4: {
      timeframe: "H4",
      bias: "WAITING_FOR_MT5",
      isBull: false,
      ema34: null,
      ema89: null,
      swingHigh: null,
      swingLow: null,
      summary: "DATA_UNAVAILABLE: Chưa kết nối dữ liệu nến H4 từ MT5.",
    },
    h1: {
      timeframe: "H1",
      bias: "WAITING_FOR_MT5",
      isBull: false,
      ema34: null,
      demandZone: null,
      supplyZone: null,
      summary: "DATA_UNAVAILABLE: Chưa kết nối dữ liệu nến H1 từ MT5.",
    },
    m15: {
      timeframe: "M15",
      patternName: "WAITING_FOR_MT5 (NO_TRADE)",
      signalSide: "NEUTRAL",
      setupScore: 0,
      confidence: 0,
      scoreType: "HEURISTIC_POINTS_OUT_OF_100",
      atr: null,
      summary: "DATA_UNAVAILABLE / WAITING_FOR_MT5: Không phát sinh tín hiệu khi mất kết nối MT5.",
    },
    scenario15m: {
      direction: "NEUTRAL",
      marketRegime: "UNKNOWN",
      title: "DATA_UNAVAILABLE — WAITING_FOR_MT5 (NO_TRADE)",
      recommendedBot: "NO_TRADE",
      entryZone: null,
      stopLoss: null,
      beTrigger: null,
      tp1: null,
      tp2: null,
      dcaCondition: "DATA_UNAVAILABLE: Chờ dữ liệu MT5 thật.",
      invalidation: "Không giao dịch và không hiển thị giá giả định khi mất kết nối MT5.",
    },
  };
}

let lastDirectProbeSnapshot = null;
let lastDirectProbeTime = 0;
let probeInFlight = null;
let cachedPythonCmd = null;

export let runtimeSecurityScrubWarning = null;

export function saveAccountConfig(cfg) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const safeDiskCfg = { ...cfg, liveArmed: false, explicitLiveGateConfirmed: false };
  delete safeDiskCfg.password;
  delete safeDiskCfg.token;
  delete safeDiskCfg.otp;
  delete safeDiskCfg.controlToken;
  delete safeDiskCfg.sessionToken;
  atomicWriteFileSync(ACCOUNT_CONFIG_FILE, JSON.stringify(safeDiskCfg, null, 2));
}

export function loadSavedAccountConfig() {
  if (fs.existsSync(ACCOUNT_CONFIG_FILE)) {
    try {
      const rawText = fs.readFileSync(ACCOUNT_CONFIG_FILE, "utf8");
      const saved = JSON.parse(rawText);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("Invalid JSON object in active-mt5-account.json");
      }
      if (saved.fixedLot !== undefined && !validateFixedLotAgainstBroker(saved.fixedLot).ok) {
        throw new Error(`Corrupted or invalid fixedLot (${saved.fixedLot}) in active-mt5-account.json`);
      }
      if (saved && (saved.password || saved.token || saved.otp || saved.sessionToken)) {
        runtimeSecurityScrubWarning = "CẢNH BÁO BẢO MẬT: Phát hiện thông tin nhạy cảm cũ trong file cấu hình runtime — đã tự động xóa khỏi đĩa; khuyến nghị đổi mật khẩu MT5.";
        const scrubbed = { ...saved, liveArmed: false, explicitLiveGateConfirmed: false, configUnverified: false };
        saveAccountConfig(scrubbed);
        return scrubbed;
      }
      if (saved && saved.login) {
        const resolvedMode = String(saved.login) === "5201362" ? "LIVE" : (saved.accountMode || "LIVE");
        return {
          ...saved,
          accountMode: resolvedMode,
          liveArmed: false,
          explicitLiveGateConfirmed: false,
          configUnverified: false,
          riskPercent: Math.min(1.0, Number(saved.riskPercent || 0.8)),
        };
      }
    } catch (err) {
      return {
        accountMode: "LIVE",
        login: "5201362",
        server: "DBGMarkets-Live",
        brokerSymbol: "XAUUSD.G",
        terminalPath: "",
        liveArmed: false,
        explicitLiveGateConfirmed: false,
        configUnverified: true,
        configError: err?.message || "Corrupted active-mt5-account.json",
        riskPercent: 0.8,
        fixedLot: null,
        connectedAt: Date.now(),
      };
    }
  }
  return {
    accountMode: "LIVE",
    login: "5201362",
    server: "DBGMarkets-Live",
    brokerSymbol: "XAUUSD.G",
    terminalPath: "",
    liveArmed: false,
    explicitLiveGateConfirmed: false,
    riskPercent: 0.8,
    fixedLot: 0.02,
    connectedAt: Date.now(),
  };
}

function resolveRealPythonOnWindows() {
  if (cachedPythonCmd) return cachedPythonCmd;
  if (process.platform !== "win32") {
    cachedPythonCmd = { bin: "python3", prefixArgs: [] };
    return cachedPythonCmd;
  }

  const candidates = [];
  const venvPy = path.join(ROOT_DIR, "packages", "mt5-broker", "bridge", ".venv", "Scripts", "python.exe");
  if (fs.existsSync(venvPy)) candidates.push({ bin: venvPy, prefixArgs: [] });

  const localAppData = process.env.LOCALAPPDATA || "";
  if (localAppData) {
    const pyRoot = path.join(localAppData, "Programs", "Python");
    if (fs.existsSync(pyRoot)) {
      try {
        for (const sub of fs.readdirSync(pyRoot).sort().reverse()) {
          const exe = path.join(pyRoot, sub, "python.exe");
          if (fs.existsSync(exe)) candidates.push({ bin: exe, prefixArgs: [] });
        }
      } catch {
        // ignore
      }
    }
  }

  for (const ver of ["313", "312", "311", "310", "39"]) {
    const c1 = `C:\\Python${ver}\\python.exe`;
    const c2 = `C:\\Program Files\\Python${ver}\\python.exe`;
    if (fs.existsSync(c1)) candidates.push({ bin: c1, prefixArgs: [] });
    if (fs.existsSync(c2)) candidates.push({ bin: c2, prefixArgs: [] });
  }

  candidates.push({ bin: "py", prefixArgs: ["-3"] });
  candidates.push({ bin: "python", prefixArgs: [] });

  for (const cand of candidates) {
    try {
      const out = execSync(`"${cand.bin}" ${cand.prefixArgs.join(" ")} -c "import sys; print(sys.executable)"`, {
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (out && !out.toLowerCase().includes("windowsapps")) {
        cachedPythonCmd = cand;
        return cand;
      }
    } catch {
      // try next
    }
  }

  cachedPythonCmd = { bin: "python", prefixArgs: [] };
  return cachedPythonCmd;
}

function invokeMt5PythonEngineDirect(extraPayload = {}, force = false) {
  const isProbeOnly = !extraPayload.action || extraPayload.action === "probe";
  const now = Date.now();
  if (isProbeOnly && !force && lastDirectProbeSnapshot && now - lastDirectProbeTime < 2200) {
    return Promise.resolve(lastDirectProbeSnapshot);
  }
  if (isProbeOnly && probeInFlight) return probeInFlight;

  // Mọi đường gọi xuống Python đều đọc từ nguồn trạng thái ARM duy nhất (getCanonicalLiveArmState)
  const armGate = getCanonicalLiveArmState(lastDirectProbeSnapshot);

  const payloadStr = JSON.stringify({
    accountMode: currentAccountConfig.accountMode || "LIVE",
    strictAccountMode: true,
    login: currentAccountConfig.login,
    password: currentAccountConfig.password || "",
    server: currentAccountConfig.server,
    brokerSymbol: currentAccountConfig.brokerSymbol || "XAUUSD.G",
    terminalPath: currentAccountConfig.terminalPath || "",
    autoManageBe: false,
    trendManagementConfig: {
      ...trendManagementConfig,
      enablePartialCloseAtSr: false,
      useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
      beAtOneR: true,
      beTriggerRMultiple: 1.0,
    },
    positiveDcaConfig: {
      ...positiveDcaConfig,
      useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
      slDistance: autoBotState.slDistance,
      tpDistance: autoBotState.tpDistance,
      maxRiskPercent: 0.5,
      maxPortfolioRiskPercent: 1.5,
      liveAuthorized: armGate.liveAuthorized,
      liveArmed: armGate.liveArmed,
      explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
      armedAccountLogin: armGate.armedAccountLogin,
    },
    strategyMode: autoBotState.enabled ? autoBotState.strategyMode : (autoBotState.configuredStrategyMode || "AUTO_REGIME"),
    minConfidence: autoBotState.minConfidence,
    maxRiskPercent: 1.0,
    maxPortfolioRiskPercent: 1.5,
    maxSpreadPoints: 65,
    maxQuoteAgeSeconds: 60,
    liveAuthorized: armGate.liveAuthorized,
    liveArmed: armGate.liveArmed,
    explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
    armedAccountLogin: armGate.armedAccountLogin,
    ...extraPayload,
  });

  const py = resolveRealPythonOnWindows();
  const args = [...py.prefixArgs, DIRECT_PROBE_SCRIPT, "--stdin"];

  const promise = new Promise((resolve) => {
    const child = spawn(py.bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch {}
        finish(new Error("PYTHON_TIMEOUT"), stdout, stderr);
      }
    }, 15000);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (!settled) { settled = true; clearTimeout(timer); finish(err, stdout, stderr); }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        finish(code === 0 ? null : new Error(`exit ${code}`), stdout, stderr);
      }
    });
    try { child.stdin.end(payloadStr); } catch {}
    function finish(err, stdout, stderr) {
      if (isProbeOnly) probeInFlight = null;
      if (stdout && stdout.trim()) {
        try {
          const lines = stdout.trim().split(/\r?\n/);
          const parsed = JSON.parse(lines[lines.length - 1]);
          if (isProbeOnly || parsed.connected !== undefined) {
            lastDirectProbeSnapshot = parsed;
            lastDirectProbeTime = Date.now();
            // Kiểm tra lại ràng buộc tài khoản của ARM mỗi khi có snapshot mới
            getCanonicalLiveArmState(parsed);
          }
          resolve(parsed);
          return;
        } catch {
          // ignore
        }
      }
      const fallback = {
        connected: false,
        errorCode: "PYTHON_EXEC_FAILED",
        errorMessage:
          process.platform === "win32"
            ? `Chưa kết nối được MT5 (${err ? err.message : stderr || "Kiểm tra Python & cửa sổ MT5"}). Hãy mở sẵn phần mềm MetaTrader 5 của sàn DBG!`
            : "Môi trường hiện tại không phải Windows có cài MetaTrader 5.",
        diagnostics: {
          step1_api: "PASS",
          step2_python_mt5: "WARN",
          step3_terminal_login: "WAIT",
          step4_symbol_quote: "WAIT",
          step5_algo_trading: "WAIT",
        },
        timestamp: Date.now(),
      };
      if (isProbeOnly) {
        lastDirectProbeSnapshot = fallback;
        lastDirectProbeTime = Date.now();
      }
      resolve(fallback);
    }
  });

  if (isProbeOnly) probeInFlight = promise;
  return promise;
}

// All broker-mutating actions are serialized across Web requests and monitor ticks.
let brokerMutationTail = Promise.resolve();
function invokeMt5PythonEngine(extraPayload = {}, force = false) {
  if (customMt5EngineInvokerForTest) {
    return Promise.resolve(customMt5EngineInvokerForTest(extraPayload, force));
  }
  const action = extraPayload.action || "probe";
  if (!["order", "dca_plus", "manage_positions", "close", "breakeven"].includes(action)) {
    return invokeMt5PythonEngineDirect(extraPayload, force);
  }
  const pending = brokerMutationTail.then(() => invokeMt5PythonEngineDirect(extraPayload, force));
  brokerMutationTail = pending.catch(() => null);
  return pending;
}

// Section 2 & 1.2: Tách biệt Chu kỳ Quản lý Vị thế/Cực trị (3 giây) khỏi Chu kỳ Phân tích Tín hiệu/Vào lệnh (6 giây).
// Khi tắt Auto (autoBotState.enabled = false), chỉ ngừng mở lệnh mới; vòng lặp bảo vệ SL vị thế đang mở vẫn tiếp tục hoạt động!
let v6PositionManagerBusy = false;
function startV6PositionManagementLoop() {
  return setInterval(async () => {
    if (v6PositionManagerBusy) return;
    if (trendManagementConfig.positionManagementEnabled === false) return;
    v6PositionManagerBusy = true;
    try {
      const management = await invokeMt5PythonEngine({ action: "manage_positions" }, true);
      if (management?.trendManagementStatus && lastDirectProbeSnapshot) {
        lastDirectProbeSnapshot.trendManagementStatus = management.trendManagementStatus;
      }
      const actions = management?.trendManagementStatus?.actions || management?.actionResult?.details?.actions || [];
      if (Array.isArray(actions) && actions.length > 0) {
        const actMsg = actions.join("\n• ");
        autoBotState.lastLog = `[QUẢN LÝ GIỮ LỆNH TREND V6] ${actMsg}`;
        recordSyncAction("TREND_MANAGER", autoBotState.lastLog);
      }
    } catch (e) {
      console.error("[V6 POS MANAGER]", e?.message || e);
    } finally {
      v6PositionManagerBusy = false;
    }
  }, POSITION_MGMT_INTERVAL_MS);
}

let v6MonitorBusy = false;
function startV6BackgroundMonitor() {
  startV6PositionManagementLoop();
  return setInterval(async () => {
    if (v6MonitorBusy) return;
    v6MonitorBusy = true;
    try {
      const probeStartUtc = Math.floor(Date.now() / 1000);
      const snap = await invokeMt5PythonEngine({ action: "probe" }, true);
      if (!snap || !snap.connected) return;

      const openPos = Array.isArray(snap.openPositions) ? snap.openPositions : [];
      const recentDeals = Array.isArray(snap.recentTrades) ? snap.recentTrades : [];

      if (knownClosedTickets.size === 0 && recentDeals.length > 0) {
        recentDeals.forEach((d) => knownClosedTickets.add(Number(d.ticket)));
      } else if (recentDeals.length > 0) {
        for (const d of [...recentDeals].reverse()) {
          const tk = Number(d.ticket);
          if (tk > 0 && !knownClosedTickets.has(tk)) {
            knownClosedTickets.add(tk);
            const prevPos = trackedOpenPositionsMap.get(Number(d.positionId)) || {};
            const pnl = Number(d.profit || 0);
            const icon = pnl > 2 ? "✅" : (pnl >= -1 ? "🛡" : "❌");
            const resLabel = pnl > 2 ? "THẮNG (CHỐT LỜI)" : (pnl >= -1 ? "HÒA VỐN (BẢO VỆ BE)" : "CHẠM DỪNG LỖ (SL)");
            if (telegramConfig.enabled && telegramConfig.notifyOrders) {
              void sendTelegramNotification([
                `${icon} <b>[ĐÃ ĐÓNG LỆNH MT5 — ${resLabel}] ${d.side} ${Number(d.volume).toFixed(2)} LOT ${d.symbol} (#${tk})</b>`,
                `🤖 <b>Bot quản lý:</b> ${getActiveBotDisplayName()}`,
                `📍 <b>Giá vào (Entry) → Giá đóng (Exit):</b> <b>${Number(d.openPrice || prevPos.entry || d.closePrice).toFixed(2)} → ${Number(d.closePrice).toFixed(2)}</b>`,
                `🛡 <b>SL / TP trước khi đóng:</b> SL: <b>${Number(prevPos.sl || 0).toFixed(2)}</b> | TP: <b>${Number(prevPos.tp || 0).toFixed(2)}</b>`,
                `📌 <b>Lý do đóng lệnh:</b> ${d.closeReason || "Tất toán vị thế trên MT5"} (${d.closedAt || "Vừa xong"})`,
                `💰 <b>Lãi / Lỗ thực tế:</b> <b>${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} USD</b>`,
                `🏦 <b>Số dư TK #${snap.accountLogin} mới:</b> <b>$${Number(snap.balance || 0).toFixed(2)} USD</b>`,
              ].join("\n"));
            }
          }
        }
      }

      openPos.forEach((p) => {
        trackedOpenPositionsMap.set(Number(p.ticket), p);
      });

      if (!autoBotState.enabled && !positiveDcaConfig.enabled) return;

      // Kiểm tra nguồn trạng thái quyền ARM chung trước khi xét mở lệnh mới hoặc DCA
      const armGate = getCanonicalLiveArmState(snap);
      if (snap.accountMode === "LIVE" && !armGate.liveArmed) {
        autoBotState.lastLog = "CHỜ MỞ KHÓA ARM LIVE: Bot đang bật quét tín hiệu nhưng chưa cấp quyền ARM LIVE cho phiên này.";
        return;
      }
      // Fail closed for NEW entries/DCA when the daily risk snapshot cannot be verified.
      // Existing position management runs in its separate loop above.
      const dailyRisk = snap.dailyRiskState;
      if (!dailyRisk || typeof dailyRisk !== "object" || Array.isArray(dailyRisk) ||
          dailyRisk.ok !== true || !Number.isSafeInteger(dailyRisk.updatedAtUtc) ||
          dailyRisk.updatedAtUtc < probeStartUtc || dailyRisk.updatedAtUtc > Math.floor(Date.now() / 1000) ||
          dailyRisk.currentDailyLossUsd < 0 ||
          Math.abs(Date.now() / 1000 - dailyRisk.updatedAtUtc) > 30 ||
          typeof dailyRisk.dailyLimitBreached !== "boolean" ||
          !Number.isFinite(dailyRisk.currentDailyLossUsd) ||
          !Number.isFinite(dailyRisk.dailyLossLimitUsd) ||
          dailyRisk.dailyLossLimitUsd <= 0) {
        autoBotState.lastRiskWarning = "Không xác minh được trạng thái giới hạn lỗ ngày. Tạm dừng mở lệnh mới và DCA đến khi đối soát thành công.";
        autoBotState.lastLog = autoBotState.lastRiskWarning;
        return;
      }
      if (dailyRisk.dailyLimitBreached || dailyRisk.currentDailyLossUsd >= dailyRisk.dailyLossLimitUsd) {
        autoBotState.lastRiskWarning = `Đã chạm giới hạn lỗ ngày (${dailyRisk.currentDailyLossUsd} / ${dailyRisk.dailyLossLimitUsd}). Tạm dừng mở lệnh mới và DCA.`;
        autoBotState.lastLog = autoBotState.lastRiskWarning;
        return;
      }

      // 1. Nếu đang có lệnh mở và người dùng BẬT chế độ DCA Dương Thuận Xu Hướng
      if (openPos.length > 0 && positiveDcaConfig.enabled) {
        if (Date.now() - positiveDcaConfig.lastDcaTime >= 4 * 60 * 1000) {
          const dcaSnap = await invokeMt5PythonEngine(
            {
              action: "dca_plus",
              positiveDcaConfig: {
                ...positiveDcaConfig,
                strategyMode: autoBotState.strategyMode,
                minConfidence: autoBotState.minConfidence,
                slDistance: autoBotState.slDistance,
                tpDistance: autoBotState.tpDistance,
                maxRiskPercent: 0.5,
                maxPortfolioRiskPercent: 1.5,
                useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
                liveAuthorized: armGate.liveAuthorized,
                liveArmed: armGate.liveArmed,
                explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
              },
              forceManual: false,
            },
            true
          );
          if (dcaSnap?.actionResult?.submitted && !dcaSnap?.actionResult?.ok) {
            positiveDcaConfig.enabled = false;
            positiveDcaConfig.lastDcaTime = Date.now();
            positiveDcaConfig.lastStatusText = "DCA TẠM KHÓA: broker đã nhận lệnh nhưng khớp chưa xác minh. Kiểm tra MT5 trước khi bật lại.";
            autoBotState.lastLog = positiveDcaConfig.lastStatusText;
            recordSyncAction("AUTO_BOT", positiveDcaConfig.lastStatusText);
            return;
          }
          if (dcaSnap?.actionResult?.ok) {
            positiveDcaConfig.lastDcaTime = Date.now();
            positiveDcaConfig.lastStatusText = `[DCA DƯƠNG ĐÃ NHỒI LỆNH] ${dcaSnap.actionResult.message}`;
            autoBotState.lastLog = positiveDcaConfig.lastStatusText;
            recordSyncAction("AUTO_BOT", positiveDcaConfig.lastStatusText);
            if (telegramConfig.enabled && telegramConfig.notifyOrders && dcaSnap.actionResult.dcaStatus?.orderResult) {
              const ord = dcaSnap.actionResult.dcaStatus.orderResult;
              ord.botName = `${getActiveBotDisplayName()} (Nhồi DCA Dương sau khi lệnh trên đã kéo BE)`;
              ord.entryReason = dcaSnap.actionResult.message;
              void sendTelegramNotification(formatOrderEntryTelegramMsg(ord, snap.accountLogin, snap.balance));
            }
            return;
          } else if (dcaSnap?.positiveDcaStatus?.reason) {
            positiveDcaConfig.lastStatusText = dcaSnap.positiveDcaStatus.reason;
          }
        }
      }

      // 2. Nếu chưa có lệnh mở và Bot Tự Động đang BẬT (Không tự vào lệnh mới nếu đang ở chế độ SEMI_AUTO_TREND hoặc PAUSE)
      if (
        openPos.length === 0 &&
        autoBotState.enabled &&
        autoBotState.strategyMode !== "SEMI_AUTO_TREND" &&
        autoBotState.strategyMode !== "PAUSE"
      ) {
        const analysis = snap.entrySignal;
        if (!analysis?.allowed || !["BUY", "SELL"].includes(analysis.side)) {
          autoBotState.lastLog = "WAIT: " + (analysis?.reason || "No valid setup");
          return;
        }
        if (Number(analysis.setupScore || analysis.confidence || 0) < autoBotState.minConfidence) return;
        const entryKey = [
          snap.accountLogin, autoBotState.strategyMode,
          analysis.side, analysis.closedM15Time
        ].join("|");
        if (previousEntryKey === entryKey) return;
        if (Date.now() - autoBotState.lastActionTime < 15 * 60 * 1000) return;
        persistEntryKey(entryKey);
        autoBotState.lastActionTime = Date.now();
        const entryReasonText = analysis.reason || analysis.patternName;
        const orderSnap = await invokeMt5PythonEngine(
          {
            action: "order",
            side: analysis.side,
            volume: getCanonicalFixedLot(),
            strategyMode: autoBotState.strategyMode,
            minConfidence: autoBotState.minConfidence,
            closedM15Time: analysis.closedM15Time,
            manualOrder: false,
            slDistance: autoBotState.slDistance,
            tpDistance: autoBotState.tpDistance,
            maxRiskPercent: 1.0,
            maxPortfolioRiskPercent: 1.5,
            slMode: trendManagementConfig.slMode,
            useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
            botName: getActiveBotDisplayName(),
            entryReason: entryReasonText,
            liveAuthorized: armGate.liveAuthorized,
            liveArmed: armGate.liveArmed,
            explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
          },
          true
        );
        if (orderSnap?.actionResult?.submitted && !orderSnap?.actionResult?.ok) {
          autoBotState.enabled = false;
          autoBotState.lastLog = "AUTO BOT TẠM KHÓA: broker đã nhận lệnh nhưng chưa xác minh khớp đầy đủ. Kiểm tra MT5 trước khi bật lại.";
          recordSyncAction("AUTO_BOT", autoBotState.lastLog);
          return;
        }
        if (orderSnap?.actionResult?.ok) {
          autoBotState.lastLog = `[AUTO BOT KHỚP LỆNH GỐC] ${orderSnap.actionResult.message}`;
          recordSyncAction("AUTO_BOT", autoBotState.lastLog);
          if (telegramConfig.enabled && telegramConfig.notifyOrders) {
            void sendTelegramNotification(formatOrderEntryTelegramMsg(orderSnap.actionResult, snap.accountLogin, snap.balance));
          }
        }
      }
    } catch (e) {
      console.error("[V6 MONITOR]", e?.message || e);
    } finally {
      v6MonitorBusy = false;
    }
  }, SIGNAL_SCAN_INTERVAL_MS);
}

// Đã tắt tự động gửi kịch bản 15 phút lên Telegram theo yêu cầu của người dùng (Chỉ thông báo đầy đủ mọi sự kiện liên quan đến LỆNH)
function readSavedTunnelUrl() {
  try {
    const f = path.join(RUNTIME_DIR, "mobile-internet-url.txt");
    if (fs.existsSync(f)) {
      const u = fs.readFileSync(f, "utf8").trim();
      if (u.startsWith("https://")) {
        internetTunnelState.active = true;
        internetTunnelState.publicUrl = u;
        internetTunnelState.provider = "Cloudflare HTTP/2 Tunnel";
        internetTunnelState.statusText = `Đang hoạt động ổn định (HTTP/2): Mở ${u} trên điện thoại (4G/5G).`;
      }
    }
  } catch {
    // ignore
  }
}

let tunnelChildProcess = null;
function startInternetTunnelForMobile() {
  readSavedTunnelUrl();
  if (tunnelChildProcess) {
    return;
  }
  internetTunnelState.statusText = "Đang khởi tạo đường hầm Cloudflare HTTP/2 (Chống lỗi 1033) cho Điện thoại 4G/5G...";
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const logFile = path.join(RUNTIME_DIR, "cloudflared.log");
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${WEB_PORT}`, "--protocol", "http2", "--no-autoupdate"],
      {
        cwd: ROOT_DIR,
        shell: process.platform === "win32",
        windowsHide: true,
      }
    );
    tunnelChildProcess = child;
    const parseChunk = (chunk) => {
      const text = chunk.toString();
      try { fs.appendFileSync(logFile, text, "utf8"); } catch {}
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        internetTunnelState.active = true;
        internetTunnelState.publicUrl = match[0];
        internetTunnelState.provider = "Cloudflare HTTP/2 Tunnel";
        internetTunnelState.statusText = `Đang hoạt động ổn định (HTTP/2): Mở ${match[0]} trên điện thoại (4G/5G toàn cầu).`;
        try {
          fs.writeFileSync(path.join(RUNTIME_DIR, "mobile-internet-url.txt"), match[0], "utf8");
        } catch {}
      }
    };
    child.stdout.on("data", parseChunk);
    child.stderr.on("data", parseChunk);
    child.on("close", () => {
      tunnelChildProcess = null;
    });
    child.on("error", () => {
      tunnelChildProcess = null;
      internetTunnelState.statusText = "Hãy chạy file BAT_WEB_DIEN_THOAI_QUA_INTERNET_4G.bat để bật link 4G/5G.";
    });
  } catch {
    tunnelChildProcess = null;
  }
}

function writeBridgeEnvAndArmFiles(cfg) {
  const bridgeDir = path.join(ROOT_DIR, "packages", "mt5-broker", "bridge");
  fs.mkdirSync(bridgeDir, { recursive: true });

  const isLive = cfg.accountMode === "LIVE";
  if (isLive) {
    // V6 must not rewrite or arm Phase7C's shared LIVE bridge profile.
    // V6 REAL orders also remain independently fail-closed in the Python broker path.
    return;
  }
  const envFileName = isLive ? ".env.phase7b-live" : ".env.phase7b-demo";
  const envFilePath = path.join(bridgeDir, envFileName);

  // A shared hard-coded fallback key would permit bridge impersonation.
  // Without a distinct, operator-supplied DEMO key, produce an inert profile.
  const apiKey = String(process.env.MT5_BRIDGE_API_KEY || "").trim();
  const bridgeApiReady = apiKey.length >= 32 && !/[\r\n]/.test(apiKey);

  const symbolMap = JSON.stringify({ XAUUSD: cfg.brokerSymbol || "XAUUSD.G" });
  const envLines = [
    `# Auto-generated by XAUUSD Web Account Connector (${cfg.accountMode})`,
    `MT5_BRIDGE_HOST=127.0.0.1`,
    `MT5_BRIDGE_PORT=8765`,
    `MT5_API_KEY=${bridgeApiReady ? apiKey : ""}`,
    `MT5_TRADING_ENABLED=${bridgeApiReady ? "true" : "false"}`,
    `MT5_ALLOW_REAL_ACCOUNT=${isLive ? "true" : "false"}`,
    `XAUUSD_PHASE7C_ALLOW_LIVE_TRADING=${isLive ? "true" : "false"}`,
    `MT5_ALLOWED_LOGINS=${cfg.login}`,
    `MT5_TERMINAL_PATH=${cfg.terminalPath || ""}`,
    `MT5_LOGIN=${cfg.login}`,
    `MT5_PASSWORD=${cfg.password || ""}`,
    `MT5_SERVER=${cfg.server || ""}`,
    `MT5_PORTABLE=false`,
    `MT5_INITIALIZE_TIMEOUT_MS=60000`,
    `MT5_FAIL_STARTUP_IF_DISCONNECTED=false`,
    `MT5_BROKER_TIME_OFFSET_SECONDS=0`,
    `MT5_SYMBOL_MAP_JSON=${symbolMap}`,
    `MT5_MAX_SPREAD_POINTS_JSON={"XAUUSD":65}`,
    `MT5_MAGIC_NUMBER=${isLive ? "270715" : "270713"}`,
    `MT5_DEVIATION_POINTS=50`,
    `MT5_LEDGER_PATH=.\\\\data\\\\mt5_bridge_${isLive ? "live" : "demo"}.sqlite3`,
    `MT5_LOG_LEVEL=INFO`,
  ];
  fs.writeFileSync(envFilePath, envLines.join("\n") + "\n", "utf8");

  const modeState = {
    version: 1,
    accountMode: isLive ? "LIVE" : "DEMO",
    liveExecutionEnabled: false,
    valid: true,
    source: "WEB_ACCOUNT_CONNECTOR",
    updatedAt: Date.now(),
    updatedBy: "web-operator",
  };
  fs.writeFileSync(ACCOUNT_MODE_FILE, JSON.stringify(modeState, null, 2), "utf8");
}

function getLanIps() {
  let nets = {};
  try {
    nets = os.networkInterfaces();
  } catch {
    // LAN discovery is optional. Keep the local dashboard available.
  }
  const lan = [];
  const tailscale = [];
  for (const [name, list] of Object.entries(nets)) {
    for (const iface of list || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        if (iface.address.startsWith("100.") || name.toLowerCase().includes("tailscale")) {
          tailscale.push(iface.address);
        } else {
          lan.push(iface.address);
        }
      }
    }
  }
  return {
    lanIp: lan[0] || "127.0.0.1",
    allLanIps: lan,
    tailscaleIp: tailscale[0] || null,
  };
}

function resolveAllowedOrigin(req) {
  const origin = String(req?.headers?.origin || "").trim();
  if (!origin) return "http://127.0.0.1:5717";
  if (
    origin.startsWith("http://127.0.0.1:") ||
    origin.startsWith("http://localhost:") ||
    origin.endsWith(".trycloudflare.com")
  ) {
    return origin;
  }
  return "http://127.0.0.1:5717";
}

function sendJson(res, status, payload, req = null) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": resolveAllowedOrigin(req),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-phase7c-token, x-mt5-api-key, x-v6-control-token",
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 262144) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function buildStatusPayload(probe) {
  readSavedTunnelUrl();
  const brokerEvidence = getV6BrokerStatusEvidence(probe);
  const isConnected = brokerEvidence.connected;
  const brokerSnapshotCurrent = brokerEvidence.dataStatus === "BROKER_REPORTED_SNAPSHOT";
  const brokerMarketFresh = brokerSnapshotCurrent && brokerEvidence.quote !== null;
  if (brokerSnapshotCurrent) {
    if (probe.accountMode === "LIVE" || probe.accountMode === "DEMO") {
      currentAccountConfig.accountMode = probe.accountMode;
    }
    if (probe.server) {
      currentAccountConfig.server = probe.server;
    }
  }
  const armGate = getCanonicalLiveArmState(probe);
  const mtfAnalysis = brokerMarketFresh && probe?.mtfAnalysis
    ? probe.mtfAnalysis : buildFallbackMtfAnalysis(null);
  const ips = getLanIps();
  return {
    status: "ok",
    reachable: true,
    mt5LiveBridgeConnected: isConnected,
    brokerEvidenceStatus: {
      dataStatus: brokerEvidence.dataStatus,
      accountDataStatus: brokerEvidence.accountDataStatus,
      quoteDataStatus: brokerEvidence.quoteDataStatus,
      brokerObservedAtMs: brokerEvidence.brokerObservedAtMs,
      note: "Status reports only validated MT5 probe values; local HTTP response time does not attest broker quote freshness.",
    },
    syncRevision,
    lastSyncAction,
    liveArmStatus: armGate,
    dailyRiskState: probe?.dailyRiskState || null,
    // Source-level disclosure only. A healthy bridge does not prove the source
    // revision deployed on Windows, or make Phase7C shadow Auto Lot executable.
    executionSizing: getV6ExecutionSizingDisclosure({
      fixedLot: getCanonicalFixedLot(),
      configVerified: configIntegrityState.verified === true &&
        currentAccountConfig.configUnverified !== true,
    }),
    loopLatencyDisclosure: {
      positionManagementIntervalMs: POSITION_MGMT_INTERVAL_MS,
      signalScanIntervalMs: SIGNAL_SCAN_INTERVAL_MS,
      note: "Chu kỳ quản lý SL/cực trị (3s) tách độc lập với chu kỳ quét tín hiệu (6s); khóa cực trị 10 giá phụ thuộc bước tick và stops-level của broker.",
    },
    telegramConfig: {
      enabled: telegramConfig.enabled,
      botToken: telegramConfig.botToken ? "•••••••••••••••• (Đã mã hóa AES-256-GCM)" : "",
      hasToken: Boolean(telegramConfig.botToken && !telegramConfig.botToken.includes("REPLACE")),
      chatId: telegramConfig.chatId || "",
      notifyOrders: telegramConfig.notifyOrders,
      notifyMtf15m: telegramConfig.notifyMtf15m,
      lastSentAt: telegramConfig.lastSentAt,
      lastStatus: telegramConfig.lastStatus,
    },
    mtfAnalysis,
    lanIp: ips.lanIp,
    tailscaleIp: ips.tailscaleIp,
    internetTunnelState,
    autoBotState,
    trendManagementConfig,
    positiveDcaConfig,
    positiveDcaStatus: probe?.positiveDcaStatus || null,
    botSampleStats,
    lastVerifiedBacktestResult,
    strategyProposals,
    actionResult: probe?.actionResult || null,
    diagnostics: probe?.diagnostics || {
      step1_api: "PASS",
      step2_python_mt5: isConnected ? "PASS" : "WARN",
      step3_terminal_login: isConnected ? "PASS" : "WAIT",
      step4_symbol_quote: isConnected && probe?.bid > 0 ? "PASS" : "WAIT",
      step5_algo_trading: isConnected && probe?.terminalTradeAllowed ? "PASS" : "WARN",
    },
    directDiagnostic: {
      connected: isConnected,
      errorCode: probe?.errorCode || null,
      errorMessage: probe?.errorMessage || null,
    },
    health: {
      status: isConnected ? "ok" : "waiting_mt5",
      connected: isConnected,
      tradingEnabled: brokerMarketFresh &&
        brokerEvidence.accountDataStatus === "BROKER_VALUES_PRESENT" &&
        (probe?.accountMode === "DEMO" || armGate.liveArmed),
      terminalTradeAllowed: brokerSnapshotCurrent && probe?.terminalTradeAllowed === true,
      expertTradeAllowed: brokerSnapshotCurrent && probe?.expertTradeAllowed === true,
      accountLogin: brokerEvidence.accountLogin,
      accountName: brokerEvidence.accountName || "",
      accountMode: brokerEvidence.accountMode || "unknown",
      configuredAccountMode: currentAccountConfig.accountMode,
      configuredBrokerSymbol: currentAccountConfig.brokerSymbol || null,
      liveExecutionArmed: armGate.liveArmed,
      accountBalance: brokerEvidence.accountBalance,
      accountEquity: brokerEvidence.accountEquity,
      accountFreeMargin: brokerEvidence.accountFreeMargin,
      accountProfit: brokerEvidence.accountProfit,
      accountCurrency: brokerEvidence.accountCurrency,
      server: brokerEvidence.server,
      brokerSymbol: brokerEvidence.brokerSymbol,
      availableGoldSymbols: brokerEvidence.availableGoldSymbols,
      accountDataStatus: brokerEvidence.accountDataStatus,
      quoteDataStatus: brokerEvidence.quoteDataStatus,
      timestamp: brokerEvidence.brokerObservedAtMs,
    },
    quote: brokerEvidence.quote,
    liveAnalysis: brokerMarketFresh ? (probe?.liveAnalysis || null) : null,
    entrySignal: brokerMarketFresh
      ? (probe?.entrySignal || { allowed: false, side: "WAIT", reason: "MT5 signal unavailable" })
      : { allowed: false, side: "WAIT", reason: "MT5 broker snapshot or quote not verified" },
    candles: brokerMarketFresh && Array.isArray(probe.candles) ? probe.candles : [],
    positions: brokerSnapshotCurrent && Array.isArray(probe.openPositions) ? probe.openPositions : [],
    recentTrades: brokerSnapshotCurrent && Array.isArray(probe.recentTrades) ? probe.recentTrades : [],
  };
}

export async function handleApiRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": resolveAllowedOrigin(req),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-phase7c-token, x-mt5-api-key, x-v6-control-token",
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${API_PORT}`);
  const pathname = parsedUrl.pathname;

  // Section 1.1: Tuyệt đối KHÔNG cấp token qua /api/v1/auth-bootstrap dựa trên địa chỉ IP localhost/LAN!
  if (pathname === "/api/v1/auth-bootstrap") {
    sendJson(res, 403, {
      ok: false,
      error: "UNAUTHENTICATED_IP_BOOTSTRAP_DISABLED",
      message: "Không cấp quyền điều khiển dựa trên địa chỉ IP nội bộ (localhost/LAN). Hãy sử dụng Mã ghép nối 1 lần (POST /api/v1/auth-pair) hoặc ZIQ_V6_CONTROL_TOKEN.",
    }, req);
    return;
  }

  // Section 1.1: Endpoint ghép nối thiết bị bằng Mã dùng 1 lần (OTP ngắn hạn)
  if (pathname === "/api/v1/auth-pair" && req.method === "POST") {
    const body = await readJsonBody(req);
    const result = verifyOneTimePairingCodeAndCreateSession(body.pairingCode, body.deviceName || "WEB");
    sendJson(res, result.status, result, req);
    return;
  }

  // Kiểm tra xác thực và phân quyền (READ_ONLY chỉ xem GET, CONTROL mới được thực hiện POST điều khiển)
  if (pathname.startsWith("/api/v1/") || pathname === "/health") {
    const authRole = resolveAuthRole(req);
    if (!authRole) {
      const hasAnyToken = Boolean(CONTROL_TOKEN || String(process.env.ZIQ_V6_READONLY_TOKEN || "").trim() || pairedDeviceSessions.size > 0);
      sendJson(res, hasAnyToken ? 401 : 503, {
        error: hasAnyToken ? "V6_CONTROL_TOKEN_INVALID" : "V6_CONTROL_TOKEN_NOT_CONFIGURED",
        message: "Yêu cầu xác thực hợp lệ (x-v6-control-token hoặc phiên ghép nối OTP) cho mọi truy cập API (kể cả localhost và mạng LAN)."
      }, req);
      return;
    }
    const isReadOnlyMethod = req.method === "GET" || req.method === "HEAD";
    if (!isReadOnlyMethod && authRole !== "CONTROL") {
      sendJson(res, 403, {
        error: "READ_ONLY_PERMISSION_DENIED",
        message: "Token chỉ có quyền xem dữ liệu (READ_ONLY); từ chối thao tác điều khiển giao dịch hoặc thay đổi cấu hình.",
      }, req);
      return;
    }
    if (!isReadOnlyMethod) {
      const replayRes = verifyReplayGuard(req);
      if (!replayRes.ok) {
        sendJson(res, replayRes.status, { error: replayRes.error, message: replayRes.message }, req);
        return;
      }
    }
  }

  // Cho phép thiết bị đã xác thực tạo mã ghép nối 1 lần (OTP 5 phút) để ghép nối thêm Điện thoại
  if (pathname === "/api/v1/auth-pair/new-code" && req.method === "POST") {
    const body = await readJsonBody(req);
    const issued = issueOneTimePairingCode(300_000, body?.role || "CONTROL");
    sendJson(res, 200, {
      ok: true,
      pairingCode: issued.code,
      expiresAt: issued.expiresAt,
      message: `Mã ghép nối 1 lần cho thiết bị mới: ${issued.code} (Hiệu lực 5 phút, chỉ dùng 1 lần).`,
    }, req);
    return;
  }

  // Section 1.2: Kết nối tài khoản luôn kết thúc ở trạng thái PAUSE + DISARMED
  if (pathname === "/api/v1/mt5/connect-account" && req.method === "POST") {
    const body = await readJsonBody(req);
    const mode = String(body.accountMode || "DEMO").trim().toUpperCase() === "LIVE" ? "LIVE" : "DEMO";
    const login = String(body.login || currentAccountConfig.login || "5201362").trim();
    const password = String(body.password || "").trim();
    const server = String(body.server || currentAccountConfig.server || "DBG Market Limited").trim();
    const brokerSymbol = String(body.brokerSymbol || currentAccountConfig.brokerSymbol || "XAUUSD.G").trim();
    const terminalPath = String(body.terminalPath ?? "").trim();

    // Tách biệt tuyệt đối Connect, Auto và ARM: Kết nối tài khoản luôn đưa về PAUSE + DISARMED
    autoBotState.enabled = false;
    autoBotState.strategyMode = "PAUSE";
    positiveDcaConfig.enabled = false;
    disarmLiveSession("Kết nối / đổi tài khoản MT5 — Đặt về PAUSE + DISARMED");

    currentAccountConfig = {
      ...currentAccountConfig,
      accountMode: mode,
      login,
      password,
      server,
      brokerSymbol,
      terminalPath,
      liveArmed: false,
      explicitLiveGateConfirmed: false,
      connectedAt: Date.now(),
    };
    saveAccountConfig(currentAccountConfig);
    writeBridgeEnvAndArmFiles(currentAccountConfig);

    const directProbe = await invokeMt5PythonEngine({ action: "probe" }, true);
    const payload = buildStatusPayload(directProbe);

    sendJson(res, 200, {
      ...payload,
      message: directProbe.connected
        ? `ĐÃ KẾT NỐI MT5 THÀNH CÔNG: TK #${directProbe.accountLogin} (${directProbe.server}) · Mã ${directProbe.brokerSymbol} · Số dư $${directProbe.balance} (Trạng thái an toàn: PAUSE + DISARMED — Hãy bấm [ARM LIVE] riêng nếu muốn cho phép mở lệnh thật)!`
        : `Đã lưu cấu hình #${login} (${brokerSymbol}) ở trạng thái PAUSE + DISARMED. Chẩn đoán MT5: ${directProbe.errorMessage}`,
    }, req);
    return;
  }

  // Section 1.2: Endpoint ARM / DISARM LIVE riêng biệt, tường minh, gắn với (sessionId, accountLogin, server)
  if (pathname === "/api/v1/mt5/fixed-lot" && req.method === "POST") {
    const body = await readJsonBody(req);
    const lotRes = setCanonicalFixedLot(body.fixedLot !== undefined ? body.fixedLot : body.volume, true);
    if (!lotRes.ok) {
      sendJson(res, lotRes.error === "CONFIG_PERSIST_FAILED" ? 500 : 400, { error: lotRes.error, message: lotRes.message }, req);
      return;
    }
    recordSyncAction(body.sourceDevice || "WEB", `Đã cập nhật Fixed Lot thống nhất: ${lotRes.fixedLot} lot.`);
    const probe = lastDirectProbeSnapshot || (await invokeMt5PythonEngine({ action: "probe" }, false));
    sendJson(res, 200, { ...buildStatusPayload(probe), fixedLot: lotRes.fixedLot }, req);
    return;
  }

  if (pathname === "/api/v1/mt5/emergency-stop" && req.method === "POST") {
    const body = await readJsonBody(req);
    autoBotState.enabled = false;
    autoBotState.strategyMode = "PAUSE";
    positiveDcaConfig.enabled = false;
    disarmLiveSession("Người vận hành kích hoạt Emergency Stop");
    recordSyncAction(body.sourceDevice || "WEB", "EMERGENCY STOP: Đã tắt Auto, tắt DCA và khóa ARM LIVE (giữ nguyên bảo vệ SL vị thế đang mở).");
    const probe = lastDirectProbeSnapshot || (await invokeMt5PythonEngine({ action: "probe" }, false));
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      emergencyStop: { ok: true, paused: true, liveArmed: false, protectiveManagementActive: true },
    }, req);
    return;
  }

  if (pathname === "/api/v1/network/tunnel" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.enabled === true && body.confirmPublicExposure === true) {
      startInternetTunnelForMobile();
      recordSyncAction(body.sourceDevice || "WEB", "Người vận hành chủ động bật Cloudflare Tunnel.");
    }
    sendJson(res, 200, { ok: true, tunnelStatus: tunnelState }, req);
    return;
  }

  if (pathname === "/api/v1/mt5/arm-live" && req.method === "POST") {
    const body = await readJsonBody(req);
    let requestedArmed, confirmLive;
    try {
      requestedArmed = parseOptionalBoolean(body.armed, "armLive.armed");
      confirmLive = parseOptionalBoolean(body.confirmLive, "armLive.confirmLive");
    } catch {
      sendJson(res, 400, { error: "INVALID_BOOLEAN", message: "armed và confirmLive phải là boolean true/false." }, req);
      return;
    }

    if (requestedArmed === false) {
      disarmLiveSession("Người vận hành chủ động khóa ARM LIVE (DISARMED)");
      recordSyncAction(body.sourceDevice || "WEB", "Đã khóa quyền giao dịch LIVE (DISARMED).");
      const probe = lastDirectProbeSnapshot || (await invokeMt5PythonEngine({ action: "probe" }, false));
      sendJson(res, 200, {
        ...buildStatusPayload(probe),
        armResult: { ok: true, liveArmed: false, message: "Đã thu hồi quyền ARM LIVE (DISARMED)." },
      }, req);
      return;
    }

    if (requestedArmed !== true || confirmLive !== true) {
      sendJson(res, 400, {
        error: "EXPLICIT_LIVE_CONFIRMATION_REQUIRED",
        message: "Thao tác ARM LIVE yêu cầu truyền rõ { armed: true, confirmLive: true }.",
      }, req);
      return;
    }

    const probe = await invokeMt5PythonEngine({ action: "probe" }, true);
    if (!probe || !probe.connected) {
      disarmLiveSession("Không thể ARM LIVE khi chưa kết nối MT5");
      sendJson(res, 400, {
        ...buildStatusPayload(probe),
        armResult: { ok: false, liveArmed: false, message: "Không thể ARM LIVE: Chưa kết nối được phần mềm MT5." },
      }, req);
      return;
    }
    const probeLogin = String(probe.accountLogin || "").trim();
    const probeServer = String(probe.server || "").trim();
    const probeMode = String(probe.accountMode || "").trim().toUpperCase();
    const probeSymbol = String(probe.brokerSymbol || "").trim();
    if (!probeLogin || !probeServer || !probeMode || !probeSymbol) {
      disarmLiveSession("Không đọc đủ thông tin tài khoản/server/loại tài khoản/symbol MT5");
      sendJson(res, 400, {
        ...buildStatusPayload(probe),
        armResult: {
          ok: false,
          liveArmed: false,
          message: "Không thể ARM LIVE: Thiếu thông tin xác minh bắt buộc từ MT5 (accountLogin, server, accountMode, brokerSymbol).",
        },
      }, req);
      return;
    }
    if (probeLogin !== String(currentAccountConfig.login || "").trim()) {
      disarmLiveSession("Tài khoản MT5 không khớp tài khoản cấu hình");
      sendJson(res, 400, {
        ...buildStatusPayload(probe),
        armResult: { ok: false, liveArmed: false, message: `Không thể ARM LIVE: Tài khoản MT5 (#${probeLogin}) khác cấu hình (#${currentAccountConfig.login}).` },
      }, req);
      return;
    }
    if (currentAccountConfig.server && !serversMatch(probeServer, currentAccountConfig.server)) {
      disarmLiveSession("Máy chủ MT5 không khớp máy chủ cấu hình");
      sendJson(res, 400, {
        ...buildStatusPayload(probe),
        armResult: { ok: false, liveArmed: false, message: `Không thể ARM LIVE: Máy chủ MT5 (${probeServer}) khác cấu hình (${currentAccountConfig.server}).` },
      }, req);
      return;
    }
    const expectedCfgMode = String(currentAccountConfig.accountMode || "").trim().toUpperCase() === "REAL"
      ? "LIVE"
      : String(currentAccountConfig.accountMode || "").trim().toUpperCase();
    const normalizedProbeMode = probeMode === "REAL" ? "LIVE" : probeMode;
    if (expectedCfgMode && normalizedProbeMode !== expectedCfgMode) {
      disarmLiveSession("Loại tài khoản MT5 không khớp cấu hình");
      sendJson(res, 400, {
        ...buildStatusPayload(probe),
        armResult: { ok: false, liveArmed: false, message: `Không thể ARM LIVE: Loại tài khoản MT5 (${normalizedProbeMode}) khác cấu hình (${expectedCfgMode}).` },
      }, req);
      return;
    }
    // Section VII.2: Daily loss % is warning-only; ARM only verifies MT5 connection, account/server/mode/symbol.

    armLiveSessionForAccount(probe.accountLogin, probe.server || currentAccountConfig.server, body.sourceDevice || "WEB");
    recordSyncAction(body.sourceDevice || "WEB", `Đã cấp quyền ARM LIVE cho TK #${probe.accountLogin} (${probe.server}) trong phiên hiện tại.`);
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      armResult: {
        ok: true,
        liveArmed: true,
        accountLogin: String(probe.accountLogin),
        server: String(probe.server || currentAccountConfig.server),
        sessionId: SERVER_BOOT_SESSION_ID,
        message: `✓ ĐÃ MỞ KHÓA ARM LIVE cho TK #${probe.accountLogin} (${probe.server}) trong phiên vận hành hiện tại!`,
      },
    }, req);
    return;
  }

  // API BẬT/TẮT & CẤU HÌNH DCA DƯƠNG THUẬN XU HƯỚNG (POSITIVE DCA)
  if (pathname === "/api/v1/mt5/positive-dca" && req.method === "POST") {
    const body = await readJsonBody(req);
    let requestedEnabled, executeNow;
    try {
      requestedEnabled = parseOptionalBoolean(body.enabled, "dca.enabled");
      executeNow = parseOptionalBoolean(body.executeNow, "dca.executeNow");
    } catch {
      sendJson(res, 400, { error: "INVALID_BOOLEAN", message: "enabled/executeNow phải là boolean true/false." }, req);
      return;
    }
    if (requestedEnabled !== undefined) positiveDcaConfig.enabled = requestedEnabled;
    if (body.maxLayers !== undefined) positiveDcaConfig.maxLayers = Math.max(1, Math.min(3, Number(body.maxLayers)));
    if (body.stepDistance !== undefined) positiveDcaConfig.stepDistance = Math.max(1.2, Number(body.stepDistance));
    if (body.fixedDcaLot !== undefined) {
      positiveDcaConfig.fixedDcaLot = body.fixedDcaLot === null ? null : Math.max(0.01, Number(body.fixedDcaLot));
    }
    if (body.dcaUseBaseLot !== undefined) positiveDcaConfig.dcaUseBaseLot = Boolean(body.dcaUseBaseLot);
    if (body.lotMultiplier !== undefined) positiveDcaConfig.lotMultiplier = Math.max(0.25, Math.min(1.0, Number(body.lotMultiplier)));

    positiveDcaConfig.lastStatusText = positiveDcaConfig.enabled
      ? `ĐÃ BẬT DCA Dương Thuận Xu Hướng (Tối đa ${positiveDcaConfig.maxLayers} tầng phụ · Bước giá +$${positiveDcaConfig.stepDistance} · ${positiveDcaConfig.fixedDcaLot ? ("Fixed DCA Lot: " + positiveDcaConfig.fixedDcaLot) : (positiveDcaConfig.dcaUseBaseLot ? "Dùng Fixed Lot gốc" : "Chưa chọn Fixed DCA Lot")}).`
      : "ĐÃ TẮT chế độ DCA Dương Thuận Xu Hướng (Chỉ đánh đơn lệnh).";

    recordSyncAction(body.sourceDevice || "WEB", positiveDcaConfig.lastStatusText);
    const armGate = getCanonicalLiveArmState();
    const actionType = executeNow === true ? "dca_plus" : "probe";
    const probe = await invokeMt5PythonEngine(
      {
        action: actionType,
        positiveDcaConfig: {
          ...positiveDcaConfig,
          maxRiskPercent: 0.5,
          maxPortfolioRiskPercent: 1.5,
          liveAuthorized: armGate.liveAuthorized,
          liveArmed: armGate.liveArmed,
          explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
        },
        forceManual: executeNow === true,
      },
      true
    );
    if (executeNow === true && probe?.actionResult?.submitted && !probe?.actionResult?.ok) {
      positiveDcaConfig.enabled = false;
      positiveDcaConfig.lastDcaTime = Date.now();
      positiveDcaConfig.lastStatusText = "DCA TẠM KHÓA: cần đối soát vị thế MT5 trước khi bật lại.";
      recordSyncAction("WEB", positiveDcaConfig.lastStatusText);
    }
    const payload = buildStatusPayload(probe);
    sendJson(res, 200, {
      ...payload,
      dcaMessage: executeNow === true
        ? probe?.actionResult?.message || positiveDcaConfig.lastStatusText
        : positiveDcaConfig.lastStatusText,
    }, req);
    return;
  }

  // API PHÊ DUYỆT / TỪ CHỐI ĐỀ XUẤT CHIẾN LƯỢC TỪ THỐNG KÊ MẪU LỆNH BOT
  if (pathname === "/api/v1/mt5/approve-proposal" && req.method === "POST") {
    const body = await readJsonBody(req);
    const propId = String(body.proposalId || "");
    const decision = String(body.decision || "APPROVED").toUpperCase() === "REJECTED" ? "REJECTED" : "APPROVED";

    const item = strategyProposals.find((p) => p.id === propId);
    if (item) {
      item.status = decision;
      item.decidedAt = Date.now();

      if (decision === "APPROVED") {
        trendManagementConfig.slMode = "STRUCTURAL_6_8";
        trendManagementConfig.beAtOneR = true;
        trendManagementConfig.enableM5StructuralTrail = true;
        trendManagementConfig.m15SpikeTrailDist = 10.0;
        trendManagementConfig.enablePartialCloseAtSr = false;
        if (propId === "PROP-04") {
          autoBotState.configuredStrategyMode = "AUTO_REGIME";
          if (autoBotState.enabled) autoBotState.strategyMode = "AUTO_REGIME";
          autoBotState.slDistance = 6.8;
          autoBotState.minConfidence = 85;
          autoBotState.lastLog = "Đã áp dụng cấu hình Đề xuất #1 (AUTO_REGIME · SL 6–8 giá · Trailing M5 trước/sau BE · Tắt chốt 50% H1).";
        } else if (propId === "PROP-01") {
          autoBotState.configuredStrategyMode = "BOT_1_TREND";
          if (autoBotState.enabled) autoBotState.strategyMode = "BOT_1_TREND";
          autoBotState.lastLog = "Đã áp dụng cấu hình Đề xuất #2 (BOT_1_TREND · SL 6–8 giá · Trần rủi ro 1.0%/1.5%).";
        } else if (propId === "PROP-02") {
          autoBotState.configuredStrategyMode = "SEMI_AUTO_TREND";
          trendManagementConfig.semiAutoAdoptManual = true;
          autoBotState.lastLog = "Đã áp dụng cấu hình Đề xuất #3: Bật chế độ Bán Tự Động nuôi SL cấu trúc M5 & Khóa đỉnh 10 giá.";
        } else if (propId === "PROP-03") {
          autoBotState.configuredStrategyMode = "BOT_2_SIDEWAY";
          if (autoBotState.enabled) autoBotState.strategyMode = "BOT_2_SIDEWAY";
          positiveDcaConfig.enabled = false;
          positiveDcaConfig.lastStatusText = "Đã tự động khóa DCA Dương khi chuyển sang Bot 4 Giao Dịch Biên Độ Ngang.";
          autoBotState.lastLog = "Đã áp dụng cấu hình Đề xuất #4: Bot 4 Giao Dịch Biên Độ Ngang (Khóa DCA Dương).";
        }
      }
    }

    recordSyncAction(body.sourceDevice || "WEB", `Phê duyệt chiến lược ${propId}: ${decision}`);
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      approvalMessage: item
        ? `${decision === "APPROVED" ? "✓ ĐÃ PHÊ DUYỆT CẤU HÌNH" : "✖ ĐÃ TỪ CHỐI"}: ${item.title}`
        : "Đã cập nhật trạng thái phê duyệt.",
    }, req);
    return;
  }

  // API CẤU HÌNH & KIỂM TRA THÔNG BÁO TELEGRAM
  if (pathname === "/api/v1/mt5/telegram-config" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.botToken !== undefined && String(body.botToken).trim() && !String(body.botToken).trim().startsWith("***") && !String(body.botToken).trim().startsWith("•") && !String(body.botToken).trim().startsWith("🔒")) {
      telegramConfig.botToken = String(body.botToken).trim();
    }
    if (body.chatId !== undefined) telegramConfig.chatId = String(body.chatId).trim();
    if (body.enabled !== undefined) telegramConfig.enabled = Boolean(body.enabled);
    if (body.notifyOrders !== undefined) telegramConfig.notifyOrders = Boolean(body.notifyOrders);
    if (body.notifyMtf15m !== undefined) telegramConfig.notifyMtf15m = Boolean(body.notifyMtf15m);
    saveTelegramConfig(telegramConfig);
    recordSyncAction(body.sourceDevice || "WEB", "Đã cập nhật cấu hình thông báo Telegram.");

    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    const payload = buildStatusPayload(probe);
    let testResult = null;
    if (body.customHtmlMessage) {
      testResult = await sendTelegramNotification(String(body.customHtmlMessage));
    } else if (body.sendTest) {
      const mtf = payload.mtfAnalysis;
      const msg = [
        `🤖 <b>XAUUSD AI MASTER V6 · KẾT NỐI TELEGRAM THÀNH CÔNG</b>`,
        `📊 Tài khoản: <b>#${payload.health.accountLogin} (${payload.health.brokerSymbol})</b> · Số dư: <b>$${payload.health.accountBalance}</b>`,
        `💵 Giá hiện tại: <b>${mtf.currentPrice}</b> · Chế độ Bot: <b>${autoBotState.strategyMode}</b>`,
        `📈 <b>Phân tích Đa khung (Cập nhật 15p):</b>`,
        `  • <b>H4:</b> ${mtf.h4.bias} (EMA34: ${mtf.h4.ema34})`,
        `  • <b>H1:</b> ${mtf.h1.bias} (Cầu: ${mtf.h1.demandZone})`,
        `  • <b>M15:</b> ${mtf.m15.patternName} (${mtf.m15.signalSide} - điểm setup ${mtf.m15.setupScore || mtf.m15.confidence}/100)`,
        `🎯 <b>Kịch bản 15p:</b> ${mtf.scenario15m.title} · Entry: <b>${mtf.scenario15m.entryZone}</b> · SL: <b>${mtf.scenario15m.stopLoss}</b> · BE: <b>${mtf.scenario15m.beTrigger}</b> · TP: <b>${mtf.scenario15m.tp2}</b>`,
      ].join("\n");
      testResult = await sendTelegramNotification(msg);
    }
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      telegramResult: testResult || { ok: true, message: "Đã lưu cấu hình Telegram." },
    }, req);
    return;
  }

  // API CẬP NHẬT NGAY PHÂN TÍCH ĐA KHUNG H4/H1/M15 & GỬI KỊCH BẢN 15 PHÚT
  if (pathname === "/api/v1/mt5/mtf-refresh" && req.method === "POST") {
    const body = await readJsonBody(req);
    const probe = await invokeMt5PythonEngine({ action: "probe" }, true);
    const payload = buildStatusPayload(probe);
    if (body.sendTelegram && telegramConfig.enabled && telegramConfig.botToken && telegramConfig.chatId) {
      const mtf = payload.mtfAnalysis;
      await sendTelegramNotification([
        `⏱ <b>KỊCH BẢN GIÁ VÀNG ĐA KHUNG (H4 · H1 · M15) — CẬP NHẬT 15 PHÚT</b>`,
        `💎 Mã: <b>${payload.health.brokerSymbol} (${mtf.currentPrice})</b>`,
        `• <b>H4:</b> ${mtf.h4.summary}`,
        `• <b>H1:</b> ${mtf.h1.summary}`,
        `• <b>M15:</b> ${mtf.m15.summary}`,
        `👉 <b>Kịch bản hành động:</b> ${mtf.scenario15m.title}`,
        `• Vùng chờ vào: <b>${mtf.scenario15m.entryZone}</b> | SL: <b>${mtf.scenario15m.stopLoss}</b> | Kéo BE: <b>${mtf.scenario15m.beTrigger}</b> | TP: <b>${mtf.scenario15m.tp1} / ${mtf.scenario15m.tp2}</b>`,
        `• Quy tắc DCA Dương: ${mtf.scenario15m.dcaCondition}`,
      ].join("\n"));
    }
    sendJson(res, 200, payload, req);
    return;
  }

  // API BẬT ĐƯỜNG HẦM INTERNET 4G/5G CHO ĐIỆN THOẠI
  if (pathname === "/api/v1/mt5/internet-tunnel" && req.method === "POST") {
    // Section II.1: Never auto-expose API via Cloudflare Tunnel on startup
    await new Promise((r) => setTimeout(r, 1500));
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, buildStatusPayload(probe), req);
    return;
  }

  // Section 1.2: Đặt lệnh tay KHÔNG ĐƯỢC tự gán cờ LIVE=true hay bỏ qua trạng thái ARM!
  if (pathname === "/api/v1/mt5/order" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!configIntegrityState.verified || currentAccountConfig.configUnverified === true || getCanonicalFixedLot() === null) {
      sendJson(res, 400, {
        error: "CONFIG_UNVERIFIED_ORDER_BLOCKED",
        orderResult: {
          ok: false,
          error: "CONFIG_UNVERIFIED_ORDER_BLOCKED",
          message: configIntegrityState.message || "Chặn đặt lệnh mới: Cấu hình Fixed Lot chưa được xác minh hoặc bị hỏng. Vui lòng lưu lại Fixed Lot hợp lệ trước.",
        },
      }, req);
      return;
    }
    const requestedSide = typeof body.side === "string" ? body.side.trim().toUpperCase() : "";
    if (requestedSide !== "BUY" && requestedSide !== "SELL") {
      sendJson(res, 400, {
        orderResult: { ok: false, message: "Phải chọn rõ BUY hoặc SELL; không tự đặt lệnh BUY mặc định." },
      }, req);
      return;
    }

    const armGate = getCanonicalLiveArmState();
    if (currentAccountConfig.accountMode === "LIVE" && !armGate.liveArmed) {
      sendJson(res, 403, {
        ...buildStatusPayload(lastDirectProbeSnapshot),
        orderResult: {
          ok: false,
          error: "LIVE_NOT_ARMED",
          message: "Từ chối đặt lệnh tay: Tài khoản LIVE đang ở trạng thái DISARMED. Bạn phải thực hiện thao tác [ARM LIVE] riêng biệt trước khi gửi lệnh!",
        },
      }, req);
      return;
    }

    const effectiveSlMode = String(body.slMode || trendManagementConfig.slMode || "STRUCTURAL_6_8");
    const probe = await invokeMt5PythonEngine(
      {
        action: "order",
        manualOrder: true,
        side: requestedSide,
        volume: Number(body.volume ?? getCanonicalFixedLot()),
        slDistance: Math.max(6.0, Math.min(8.0, Number(body.slDistance ?? autoBotState.slDistance ?? 6.8))),
        tpDistance: Number(body.tpDistance ?? autoBotState.tpDistance ?? 16.0),
        slMode: effectiveSlMode,
        useStructuralSl68: effectiveSlMode === "STRUCTURAL_6_8",
        botName: `${getActiveBotDisplayName()} (Kích hoạt từ ${body.sourceDevice || "Web"})`,
        maxRiskPercent: 1.0,
        maxPortfolioRiskPercent: 1.5,
        liveAuthorized: armGate.liveAuthorized,
        liveArmed: armGate.liveArmed,
        explicitLiveGateConfirmed: armGate.explicitLiveGateConfirmed,
        armedAccountLogin: armGate.armedAccountLogin,
        entryReason: body.entryReason || `Lệnh ${body.side} theo cấu trúc ${effectiveSlMode === "STRUCTURAL_6_8" ? "SL 6–8 giá & TP kiểm tra cản gần H1/H4" : "SL/TP tùy chọn"}`,
      },
      true
    );
    const payload = buildStatusPayload(probe);
    recordSyncAction(body.sourceDevice || "WEB", probe?.actionResult?.message || `Đặt lệnh ${body.side}`);
    if (probe?.actionResult?.ok && telegramConfig.enabled && telegramConfig.notifyOrders) {
      void sendTelegramNotification(formatOrderEntryTelegramMsg(probe.actionResult, payload.health.accountLogin, payload.health.accountBalance));
    }
    sendJson(res, 200, {
      ...payload,
      orderResult: probe?.actionResult || {
        ok: false,
        message: probe?.errorMessage || "Chưa kết nối được phần mềm MT5 trên máy tính.",
      },
    }, req);
    return;
  }

  if (pathname === "/api/v1/mt5/close" && req.method === "POST") {
    const body = await readJsonBody(req);
    let ticket;
    try {
      ticket = parseRequiredTicket(body.ticket);
    } catch {
      sendJson(res, 400, {
        closeResult: { ok: false, message: "Phải chọn ticket nguyên dương chính xác để đóng một vị thế." },
      }, req);
      return;
    }
    const probe = await invokeMt5PythonEngine({ action: "close", ticket }, true);
    const payload = buildStatusPayload(probe);
    sendJson(res, 200, {
      ...payload,
      closeResult: probe?.actionResult || { ok: false, message: probe?.errorMessage || "Không thể đóng vị thế." },
    }, req);
    return;
  }

  if (pathname === "/api/v1/mt5/breakeven" && req.method === "POST") {
    const body = await readJsonBody(req);
    let ticket;
    try {
      ticket = parseRequiredTicket(body.ticket);
    } catch {
      sendJson(res, 400, {
        beResult: { ok: false, message: "Phải chọn ticket chính xác để dời BE; không dời hàng loạt ngầm định." },
      }, req);
      return;
    }
    const probe = await invokeMt5PythonEngine({ action: "breakeven", ticket }, true);
    const payload = buildStatusPayload(probe);
    sendJson(res, 200, {
      ...payload,
      beResult: probe?.actionResult || { ok: false, message: probe?.errorMessage || "Không thể dời SL Hòa vốn." },
    }, req);
    return;
  }

  // Section 1.2: Bật Auto KHÔNG ĐƯỢC tự động ARM LIVE!
  if (pathname === "/api/v1/mt5/auto-bot" && req.method === "POST") {
    const body = await readJsonBody(req);
    let requestedEnabled, adoptManual;
    try {
      requestedEnabled = parseOptionalBoolean(body.enabled, "autoBot.enabled");
      adoptManual = parseOptionalBoolean(body.semiAutoAdoptManual, "autoBot.semiAutoAdoptManual");
    } catch {
      sendJson(res, 400, { error: "INVALID_BOOLEAN", message: "enabled/semiAutoAdoptManual phải là boolean true/false." }, req);
      return;
    }
    if (body.fixedLot !== undefined || body.volume !== undefined) {
      const lotRes = setCanonicalFixedLot(body.fixedLot !== undefined ? body.fixedLot : body.volume, true);
      if (!lotRes.ok) {
        sendJson(res, lotRes.error === "CONFIG_PERSIST_FAILED" ? 500 : 400, { error: lotRes.error, message: lotRes.message }, req);
        return;
      }
    }
    if (body.slDistance !== undefined) autoBotState.slDistance = Math.max(6.0, Math.min(8.0, Number(body.slDistance)));
    if (body.tpDistance !== undefined) autoBotState.tpDistance = Math.max(2, Number(body.tpDistance));
    if (body.minConfidence !== undefined) autoBotState.minConfidence = Math.max(60, Number(body.minConfidence));
    if (body.strategyMode !== undefined) {
      const reqStrat = String(body.strategyMode).trim().toUpperCase();
      autoBotState.configuredStrategyMode = reqStrat;
      if (autoBotState.enabled) {
        autoBotState.strategyMode = reqStrat;
      }
    }
    if (requestedEnabled !== undefined) {
      autoBotState.enabled = requestedEnabled;
      if (!requestedEnabled) {
        autoBotState.strategyMode = "PAUSE";
      } else {
        // TUYỆT ĐỐI KHÔNG tự động gán liveArmed = true khi bật Auto!
        if (autoBotState.strategyMode === "PAUSE") {
          autoBotState.strategyMode = autoBotState.configuredStrategyMode || "AUTO_REGIME";
        }
      }
    }
    if (body.slMode !== undefined) trendManagementConfig.slMode = String(body.slMode);
    if (adoptManual !== undefined) trendManagementConfig.semiAutoAdoptManual = adoptManual;
    if (body.m15SpikeTrailDist !== undefined) trendManagementConfig.m15SpikeTrailDist = Math.max(5, Number(body.m15SpikeTrailDist));
    trendManagementConfig.enablePartialCloseAtSr = false;

    const armGate = getCanonicalLiveArmState();
    const armNotice = currentAccountConfig.accountMode === "LIVE"
      ? (armGate.liveArmed ? "LIVE ARMED" : "ĐANG DISARMED — Cần bấm [ARM LIVE] riêng để gửi lệnh thật")
      : "DEMO";

    autoBotState.lastLog = autoBotState.enabled
      ? `ĐÃ BẬT BOT QUÉT TÍN HIỆU (${currentAccountConfig.brokerSymbol || "XAUUSD.G"} · Chế độ ${autoBotState.strategyMode} · Lot ${getCanonicalFixedLot()} · Quyền thực thi: ${armNotice}).`
      : `Đã TẠM DỪNG mở lệnh mới (Trạng thái: PAUSE · Vẫn tiếp tục bảo vệ SL cho vị thế đang mở).`;
    recordSyncAction(body.sourceDevice || "WEB", autoBotState.lastLog);
    if (telegramConfig.enabled && telegramConfig.notifyOrders && body.enabled !== undefined) {
      void sendTelegramNotification(`🤖 <b>CẬP NHẬT TRẠNG THÁI BOT (${body.sourceDevice || "WEB"})</b>\n${autoBotState.lastLog}`);
    }
    if (lastDirectProbeSnapshot) {
      void invokeMt5PythonEngine({ action: "probe" }, true);
      sendJson(res, 200, buildStatusPayload(lastDirectProbeSnapshot), req);
      return;
    }
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, buildStatusPayload(probe), req);
    return;
  }

  // API THU THẬP MẪU NẾN TỪ MT5, CHẠY BACKTEST ĐỒNG NHẤT CHẠY THẬT (IN-SAMPLE / VALIDATION / OUT-OF-SAMPLE)
  if (pathname === "/api/v1/mt5/run-backtest" && req.method === "POST") {
    const body = await readJsonBody(req);
    const reqMode = String(body.strategyMode || autoBotState.configuredStrategyMode || "AUTO_REGIME");
    const startingBalance = readExplicitBacktestStartingBalance(body.startingBalance);
    if (startingBalance === null) {
      sendJson(res, 422, {
        ok: false, error: "EXPLICIT_BACKTEST_BALANCE_REQUIRED",
        message: "Backtest cần số vốn giả định dương do người dùng nhập; không tự điền số dư MT5 chưa xác minh hoặc vốn mẫu.",
      }, req);
      return;
    }
    const probe = await invokeMt5PythonEngine(
      {
        action: "run_backtest",
        strategyMode: reqMode,
        minConfidence: Number(body.minConfidence || autoBotState.minConfidence || 85),
        m15SpikeTrailDist: Number(body.m15SpikeTrailDist || trendManagementConfig.m15SpikeTrailDist || 10.0),
        beAtOneR: body.beAtOneR !== undefined ? Boolean(body.beAtOneR) : true,
        enableM5StructuralTrail: body.enableM5StructuralTrail !== undefined ? Boolean(body.enableM5StructuralTrail) : true,
        enablePeakLock: body.enablePeakLock !== undefined ? Boolean(body.enablePeakLock) : true,
        volume: Number(body.volume ?? getCanonicalFixedLot()),
        startingBalance,
      },
      true
    );
    const btRes = probe?.actionResult;
    if (btRes && btRes.ok) {
      lastVerifiedBacktestResult = btRes;
      const byGrp = btRes.byStrategyGroup || {};
      botSampleStats = botSampleStats.map((row) => {
        const g = byGrp[row.botId] || (row.botId === reqMode ? btRes.byPeriod?.FULL_DATASET : null);
        if (!g || g.closedTradeCount === 0) return row;
        return {
          ...row,
          dataStatus: "ĐÃ KIỂM CHỨNG TỪ DỮ LIỆU NẾN MT5",
          isSimulatedSampleData: false,
          dcaEvaluationStatus: btRes.dcaEvaluationStatus || "CHƯA ĐÁNH GIÁ DCA",
          sampleSize: g.closedTradeCount,
          openAtEndCount: g.openAtEndCount || 0,
          wins: g.wins,
          breakevens: g.breakevens,
          losses: g.losses,
          winRatePercent: g.winRatePct,
          breakevenRatePercent: g.breakevenRatePct,
          lossRatePercent: g.lossRatePct,
          profitFactor: g.profitFactor,
          expectancyR: g.expectancyR,
          maxDrawdownPct: g.maxDrawdownPct,
          maxConsecutiveLosses: g.maxConsecutiveLosses,
          netPnlUsd: g.netPnlUsd,
        };
      });
      strategyProposals[0] = {
        ...strategyProposals[0],
        sampleEvidence: btRes.message,
        status: "PENDING",
      };
      recordSyncAction("BACKTEST_ENGINE", btRes.message);
    }
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      backtestResult: btRes || {
        ok: false,
        status: "CHƯA CÓ DỮ LIỆU",
        dcaEvaluationStatus: "CHƯA ĐÁNH GIÁ DCA",
        message: "CHƯA CÓ DỮ LIỆU: Chưa kết nối được MT5 để chạy Backtest trực tiếp từ dữ liệu giá.",
      },
    }, req);
    return;
  }

  if (pathname === "/api/v1/mt5/status" || pathname === "/api/v1/health" || pathname === "/health") {
    const force = parsedUrl.searchParams.get("force") === "1";
    const probe = await invokeMt5PythonEngine({ action: "probe" }, force);
    sendJson(res, 200, buildStatusPayload(probe), req);
    return;
  }

  sendJson(res, 200, {
    status: "ok",
    path: pathname,
    autoBotState,
    trendManagementConfig,
    positiveDcaConfig,
    liveArmStatus: getCanonicalLiveArmState(),
    botSampleStats,
    lastVerifiedBacktestResult,
    strategyProposals,
    accountConfig: { ...currentAccountConfig, password: "***", liveArmed: false },
    timestamp: Date.now(),
  }, req);
}

function getStandaloneHtmlPath() {
  const candidates = [
    path.join(ROOT_DIR, "apps", "web", "public", "standalone-ui.html"),
    path.join(ROOT_DIR, "MO_WEB_TRUC_TIEP_KHONG_CAN_SERVER.html"),
    path.join(ROOT_DIR, "apps", "web", "dist", "index.html"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

writeBridgeEnvAndArmFiles(currentAccountConfig);

export const apiServer = http.createServer((req, res) => {
  void handleApiRequest(req, res);
});

export const webServer = http.createServer((req, res) => {
  const reqUrl = req.url || "/";
  if (reqUrl.startsWith("/api/") || reqUrl === "/health") {
    void handleApiRequest(req, res);
    return;
  }

  const htmlPath = getStandaloneHtmlPath();
  if (!htmlPath) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Missing standalone-ui.html");
    return;
  }

  // Section 1.1: Tuyệt đối KHÔNG nhúng CONTROL_TOKEN vào HTML trả về cho client chưa xác thực!
  const html = fs.readFileSync(htmlPath, "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
});

function failOnListenError(label, port, err) {
  const code = err && typeof err.code === "string" ? err.code : "UNKNOWN";
  console.error(`[V6_${label}_LISTEN_FAILED] port=${port} code=${code}: ${err?.message || "unknown listen error"}`);
  if (code === "EADDRINUSE") {
    console.error("Port already in use: stop the conflicting service manually after verifying its identity. No automatic process termination.");
  }
  process.exit(1);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
  startV6BackgroundMonitor();
  apiServer.on("error", (err) => failOnListenError("API", API_PORT, err));
  webServer.on("error", (err) => failOnListenError("WEB", WEB_PORT, err));

  const API_HOST = process.env.V6_API_HOST || "127.0.0.1";
  const WEB_HOST = process.env.V6_ALLOW_LAN_WEB === "true" ? "0.0.0.0" : (process.env.V6_WEB_HOST || "127.0.0.1");
  apiServer.listen(API_PORT, API_HOST, () => {
    console.log(`XAUUSD_STANDALONE_API=ONLINE|HOST=${API_HOST}|PORT=${API_PORT}`);
  });

  webServer.listen(WEB_PORT, WEB_HOST, () => {
    const ips = getLanIps();
    console.log(`XAUUSD_STANDALONE_WEB=ONLINE|PORT=${WEB_PORT}`);
    console.log(`LAPTOP_URL=http://localhost:${WEB_PORT}/`);
    console.log(`MOBILE_WIFI_URL=http://${ips.lanIp}:${WEB_PORT}/phase7c-mobile`);
    console.log(`PAIRING_OTP_READY=TRUE|FILE=.runtime/v6-pairing-otp.txt`);
    // Section II.1: Never auto-expose API via Cloudflare Tunnel on startup
  });
}
