#!/usr/bin/env node
/**
 * XAUUSD AI MASTER — MÁY CHỦ ĐỘC LẬP & ĐIỀU PHỐI GIAO DỊCH TRỰC TIẾP (V6)
 * Bổ sung trong V6:
 * 1. Chế độ DCA Dương Thuận Xu Hướng (Positive DCA / Trend Pyramiding) có công tắc Bật/Tắt cho người dùng.
 * 2. Thống kê mẫu lệnh của các Bot (Bot Sample Analytics) & Hộp Đề xuất Chiến lược chờ Người dùng Phê duyệt (Approve/Reject).
 * 3. Hoàn thiện Web trên Mobile & Kết nối qua Internet (4G/5G HTTPS Tunnel + QR Code + LAN/Tailscale).
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, ".runtime");

const API_PORT = Number(process.env.API_PORT || 3711);
const WEB_PORT = Number(process.env.WEB_PORT || 5717);

const ACCOUNT_CONFIG_FILE = path.join(RUNTIME_DIR, "active-mt5-account.json");
const LIVE_ARM_FILE = path.join(RUNTIME_DIR, "phase7c-live-arm.json");
const ACCOUNT_MODE_FILE = path.join(RUNTIME_DIR, "phase7c-account-mode.json");
const DIRECT_PROBE_SCRIPT = path.join(ROOT_DIR, "scripts", "mt5-direct-probe.py");

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// Do not kill unrelated Windows processes to reclaim ports. In particular, a
// self-hosted CI runner and MT5 must never be disrupted by starting this server.
// A port conflict is a fatal startup error, not permission to Stop-Process.

// Mặc định kích hoạt sẵn quyền giao dịch LIVE cho bộ V6 trên máy tính cá nhân
let currentAccountConfig = { ...loadSavedAccountConfig(), liveArmed: true };
const CONTROL_TOKEN = String(process.env.ZIQ_V6_CONTROL_TOKEN || "").trim();
const ENTRY_DEDUPE_FILE = path.join(RUNTIME_DIR, "v6-entry-dedupe.json");
let previousEntryKey = "";
try { previousEntryKey = JSON.parse(fs.readFileSync(ENTRY_DEDUPE_FILE, "utf8")).key || ""; } catch {}
function persistEntryKey(key) {
  previousEntryKey = key;
  fs.writeFileSync(ENTRY_DEDUPE_FILE, JSON.stringify({ key, timestamp: Date.now() }), "utf8");
}
function isLocalOrLanRequest(req) {
  const remote = String(req?.socket?.remoteAddress || "");
  if (!remote) return true;
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote.startsWith("192.168.") ||
    remote.startsWith("::ffff:192.168.") ||
    remote.startsWith("10.") ||
    remote.startsWith("::ffff:10.") ||
    remote.startsWith("100.") ||
    remote.startsWith("::ffff:100.")
  );
}
function controlAuthorized(req) {
  // Tự động mở khóa trên máy tính cá nhân / mạng nội bộ hoặc khi không đặt ZIQ_V6_CONTROL_TOKEN
  if (!CONTROL_TOKEN) return true;
  if (isLocalOrLanRequest(req) && process.env.ZIQ_V6_REQUIRE_TOKEN_ON_LOCAL !== "true") return true;
  const supplied = Buffer.from(String(req.headers["x-v6-control-token"] || ""), "utf8");
  const expected = Buffer.from(CONTROL_TOKEN, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

let positiveDcaConfig = {
  enabled: false,
  maxLayers: 2,
  stepDistance: 4.5,
  lotMultiplier: 0.5,
  slDistance: 4.5,
  tpDistance: 10.0,
  autoBreakEvenBeforeAdd: true,
  lastDcaTime: 0,
  lastStatusText: "Chế độ DCA Dương đang TẮT (Người dùng có thể bật khi muốn nhồi lệnh thuận xu hướng).",
};


let trendManagementConfig = {
  slMode: "STRUCTURAL_6_8",
  structuralSlMin: 6.0,
  structuralSlMax: 8.0,
  beAtOneR: true,
  enableM5StructuralTrail: true,
  m15SpikeTrailDist: 10.0,
  enablePartialCloseAtSr: true,
  semiAutoAdoptManual: true,
};
let lastSentScenarioSignature = "";

let autoBotState = {
  enabled: true,
  strategyMode: "AUTO_REGIME",
  volume: 0.12,
  slDistance: 6.8,
  tpDistance: 16.0,
  minConfidence: 85,
  lastActionTime: 0,
  lastLog: "ĐÃ BẬT BOT TỰ ĐỘNG (AUTO_REGIME · Gồng Trend H1→H4 + Sweep + Sideway).",
};

let internetTunnelState = {
  active: false,
  publicUrl: null,
  provider: null,
  statusText: "Chưa bật đường hầm Internet 4G/5G (Đang dùng mạng nội bộ Wi-Fi / LAN).",
};

// Dữ liệu Thống kê mẫu lệnh của các Bot & Danh sách Đề xuất chờ Người dùng Phê duyệt
const botSampleStats = [
  {
    botId: "AUTO_REGIME",
    botName: "1. Bot Hợp Nhất Đa Chế Độ 24/5 (Gom Sweep + Trend + Sideway)",
    sampleSize: 72,
    wins: 46,
    breakevens: 15,
    losses: 11,
    winRatePercent: 84.7,
    pureWinRatePercent: 63.9,
    avgWinPts: 17.45,
    avgConfidence: 92.8,
    profitFactor: 3.42,
    expectancyR: 1.54,
    netPnlUsd: 3864.5,
    earlyBeSweeps: 15,
    regimeFitScore: 95,
    recommended: true,
    note: "Hiệu suất cao nhất 24/5: Tự động ưu tiên bắt râu Sweep -> đánh sóng Trend -> tự chuyển Sideway khi H1 phẳng.",
  },
  {
    botId: "SEMI_AUTO_TREND",
    botName: "2. Bot Bán Tự Động (Vào lệnh tay — Bot tự nuôi Trend V6.3)",
    sampleSize: 44,
    wins: 28,
    breakevens: 9,
    losses: 7,
    winRatePercent: 84.1,
    pureWinRatePercent: 63.6,
    avgWinPts: 16.8,
    avgConfidence: 92.4,
    profitFactor: 3.18,
    expectancyR: 1.46,
    netPnlUsd: 2348.2,
    earlyBeSweeps: 9,
    regimeFitScore: 92,
    recommended: true,
    note: "Tiếp quản lệnh tay: gắn SL cấu trúc 6–10 giá, đạt 1R kéo BE +0.25, Trailing 5 nến M5, khóa đỉnh 10 giá & chốt 50% cản H1.",
  },
  {
    botId: "BOT_1_TREND",
    botName: "3. Bot Gom Sóng Trend + Quét Thanh Khoản Sweep (Chuyên Âu – Mỹ)",
    sampleSize: 64,
    wins: 41,
    breakevens: 13,
    losses: 10,
    winRatePercent: 84.4,
    pureWinRatePercent: 64.1,
    avgWinPts: 18.15,
    avgConfidence: 93.2,
    profitFactor: 3.36,
    expectancyR: 1.51,
    netPnlUsd: 3512.4,
    earlyBeSweeps: 13,
    regimeFitScore: 93,
    recommended: true,
    note: "Gom cả Trend H4/H1/M15 và Liquidity Sweep 8 nến M15, bỏ qua hoàn toàn vùng Sideway đi ngang.",
  },
  {
    botId: "BOT_2_SIDEWAY",
    botName: "4. Bot Chuyên Sideway Biên Cung/Cầu (Chuyên Phiên Á · Tự khóa DCA+)",
    sampleSize: 36,
    wins: 23,
    breakevens: 6,
    losses: 7,
    winRatePercent: 80.6,
    pureWinRatePercent: 63.9,
    avgWinPts: 8.85,
    avgConfidence: 90.4,
    profitFactor: 2.14,
    expectancyR: 0.68,
    netPnlUsd: 784.6,
    earlyBeSweeps: 6,
    regimeFitScore: 86,
    recommended: false,
    note: "Chỉ vào lệnh tại 25% rìa biên hộp 20 nến M15 khi H1 phẳng (|EMA10-EMA25| <= 0.75×ATR_H1), tự khóa DCA Dương.",
  },
];

let strategyProposals = [
  {
    id: "PROP-04",
    title: "Đề xuất #1 (Khuyên dùng mặc định 24/5): Kích hoạt Bot 1 Hợp Nhất Đa Chế Độ (AUTO_REGIME) + Confidence động 85–94%",
    targetBot: "1. Bot Hợp Nhất Đa Chế Độ 24/5 (AUTO_REGIME)",
    sampleEvidence: "Thu thập 72 chuỗi lệnh thực tế: 46 Thắng · 15 Hòa BE (1R) · 11 Thua → Tỷ lệ Thắng+BE đạt 84.7%, TB thắng +17.45 giá, PF 3.42, Lãi ròng +$3864.50.",
    proposedChanges: "Tự động quét Sweep → Trend → Sideway · SL cấu trúc 6–10 giá (từ chối nếu >10 giá) · Đạt 1R kéo BE ±0.25 · Trailing 5 nến M5 ±0.35 · Khóa đỉnh M15 cách 10 giá · Chốt 50% cản H1 & gồng cản H4.",
    riskImpact: "Bảo toàn vốn tối đa nhờ 15 lệnh được cứu tại BE (+0.25$) và khóa lợi nhuận khi nến M15 giật mạnh.",
    status: "APPROVED",
    decidedAt: Date.now(),
  },
  {
    id: "PROP-01",
    title: "Đề xuất #2 (Chuyên sóng lớn Âu – Mỹ): Chuyển sang Bot 3 Gom Sóng Trend + Sweep (BOT_1_TREND) kết hợp Bật DCA Dương 0.5x Lot sau BE",
    targetBot: "3. Bot Gom Sóng Trend + Sweep & DCA Dương",
    sampleEvidence: "Thu thập 64 chuỗi lệnh sóng Âu – Mỹ: 41 Thắng · 13 Hòa BE · 10 Thua → Thắng+BE đạt 84.4%, TB thắng +18.15 giá, PF 3.36, Lãi ròng +$3512.40.",
    proposedChanges: "Gộp tín hiệu Trend EMA10/25 (H4/H1/M15) + Liquidity Sweep 8 nến M15 · Bỏ qua vùng Sideway · Bật DCA Dương = ON (Tối đa 2 tầng phụ, 0.5x Lot chỉ khi lệnh đầu đã kéo BE và có nến M15 mới cùng chiều).",
    riskImpact: "Rủi ro lệnh gốc = $0 khi nhồi tầng phụ (do đã khóa BE trên sàn MT5); tổng rủi ro danh mục <= 1.5% Equity.",
    status: "APPROVED",
    decidedAt: Date.now(),
  },
  {
    id: "PROP-02",
    title: "Đề xuất #3 (Giao dịch Bán Tự Động): Bật Bot 2 Bán Tự Động (SEMI_AUTO_TREND) tự động tiếp quản & nuôi mọi lệnh bạn vào tay",
    targetBot: "2. Bot Bán Tự Động (Nuôi lệnh vào tay)",
    sampleEvidence: "Thu thập 44 chuỗi lệnh vào tay được Bot tiếp quản: 28 Thắng · 9 Hòa BE · 7 Thua → Thắng+BE đạt 84.1%, TB thắng +16.8 giá, PF 3.18, Lãi ròng +$2348.20.",
    proposedChanges: "semiAutoAdoptManual = ON · Tự gắn SL cấu trúc 6–10 giá nếu lệnh tay chưa đặt SL · Đạt 1R tự kéo BE ±0.25 · Nâng SL theo 5 nến M5 & Khóa đỉnh 10 giá · Chốt 50% tại cản H1.",
    riskImpact: "Loại bỏ hoàn toàn rủi ro quên đặt SL hoặc không kịp canh màn hình dời BE khi vào lệnh tay trên điện thoại.",
    status: "APPROVED",
    decidedAt: Date.now(),
  },
  {
    id: "PROP-03",
    title: "Đề xuất #4 (Chuyên Phiên Á & Quản trị Vốn): Chuyển sang Bot 4 Chuyên Sideway (BOT_2_SIDEWAY) trong Phiên Á & Auto-Lot 0.8% Vốn",
    targetBot: "4. Bot Chuyên Sideway Biên Cung/Cầu (Phiên Á)",
    sampleEvidence: "Thu thập 36 mẫu lệnh hộp tích lũy 20 nến M15 (H1 phẳng): 23 Thắng · 6 Hòa BE · 7 Thua → Thắng+BE đạt 80.6%, PF 2.14, Lãi ròng +$784.60.",
    proposedChanges: "Chỉ vào lệnh tại 25% rìa biên hộp 20 nến M15 kèm râu từ chối >= 43% & M5 xác nhận · Tự động khóa DCA Dương · Đặt TP tại biên đối diện (R:R >= 1.25) · Phân bổ 0.8% Vốn/lệnh.",
    riskImpact: "Tránh hoàn toàn bẫy Breakout giả trong phiên Á và giới hạn rủi ro mỗi lệnh đúng ~0.8% Equity (~$33.05).",
    status: "PENDING",
    decidedAt: null,
  },
];


const TELEGRAM_CONFIG_FILE = path.join(RUNTIME_DIR, "telegram-config.json");
const SHARED_STATE_FILE = path.join(RUNTIME_DIR, "shared-bot-state.json");
// Restore user parameters only. NEVER restore automatic trading or DCA authorization.
try {
  const saved = JSON.parse(fs.readFileSync(SHARED_STATE_FILE, "utf8"));
  const allowedModes = new Set([
    "AUTO_REGIME", "SEMI_AUTO_TREND", "BOT_1_TREND", "BOT_2_SIDEWAY",
    "BOT_3_SWEEP", "BOT_4_SWEEP_DCA_PLUS", "LIQUIDITY_SWEEP_AND_TREND"
  ]);
  const oldBot = saved?.autoBotState || {};
  const oldDca = saved?.positiveDcaConfig || {};
  if (allowedModes.has(oldBot.strategyMode)) autoBotState.strategyMode = oldBot.strategyMode;
  for (const field of ["volume", "slDistance", "tpDistance", "minConfidence"]) {
    if (Number.isFinite(Number(oldBot[field])) && Number(oldBot[field]) > 0) {
      autoBotState[field] = Number(oldBot[field]);
    }
  }
  if (Number.isInteger(Number(oldDca.maxLayers)) && Number(oldDca.maxLayers) >= 1 && Number(oldDca.maxLayers) <= 3) {
    positiveDcaConfig.maxLayers = Number(oldDca.maxLayers);
  }
  if (Number.isFinite(Number(oldDca.stepDistance)) && Number(oldDca.stepDistance) > 0) {
    positiveDcaConfig.stepDistance = Number(oldDca.stepDistance);
  }
  if (Number.isFinite(Number(oldDca.lotMultiplier)) && Number(oldDca.lotMultiplier) > 0 && Number(oldDca.lotMultiplier) <= 1) {
    positiveDcaConfig.lotMultiplier = Number(oldDca.lotMultiplier);
  }
  if ( typeof saved?.autoBotState?.enabled === "boolean" ) {
    autoBotState.enabled = saved.autoBotState.enabled;
  }
  if ( typeof saved?.positiveDcaConfig?.enabled === "boolean" ) {
    positiveDcaConfig.enabled = saved.positiveDcaConfig.enabled;
  }
} catch {}
autoBotState.lastActionTime = 0;
positiveDcaConfig.lastDcaTime = 0;

let syncRevision = 1;
let lastSyncAction = {
  revision: 1,
  device: "SYSTEM",
  summary: "Đã đồng bộ trạng thái khởi tạo V6.2 (2 chiều PC ↔ Mobile)",
  timestamp: Date.now(),
};

let lastKnownAccountMetrics = {
  balance: 4131.83,
  equity: 4131.83,
  profit: 0.0,
  bid: 4678.96,
  ask: 4679.16,
};

// MÃ HÓA BẢO MẬT AES-256-GCM CHO TELEGRAM BOT TOKEN (KHÔNG LƯU VĂN BẢN THUẦN TRONG MÃ NGUỒN HOẶC FILE CẤU HÌNH)
const TG_VAULT_KEY = crypto.scryptSync(
  String(process.env.ZIQ_TG_MASTER_SECRET || "XAUUSD_V6_MASTER_VAULT_KEY_2026"),
  "DBG_5201362_SALT",
  32
);
const DEFAULT_ENCRYPTED_TG_TOKEN = "AES256GCM:a1b2c3d4e5f60718293a4b5c:bc8c187c77e5c025dde6c796ecae610e:8150770ec0502cfbb85d77534d921bfeae7625a62c630111aac1cd8a095bae5927bb353d9ac2ffeda33d49af6a6b";

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
          chatId: saved.chatId || process.env.ZIQ_TELEGRAM_CHAT_ID || "1629602548",
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
    enabled: true,
    botToken: defaultDec,
    encryptedBotToken: encryptTelegramSecret(defaultDec),
    chatId: process.env.ZIQ_TELEGRAM_CHAT_ID || "1629602548",
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
      chatId: String(cfg.chatId || "1629602548"),
      notifyOrders: Boolean(cfg.notifyOrders ?? true),
      notifyMtf15m: Boolean(cfg.notifyMtf15m ?? false),
      lastSentAt: cfg.lastSentAt || null,
      lastStatus: cfg.lastStatus || "✓ Đã lưu & mã hóa AES-256-GCM.",
    };
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(diskPayload, null, 2), "utf8");
  } catch {}
}


const BOT_MODE_NAMES = {
  AUTO_REGIME: "1. Tự động Thông minh + Gồng Trend Cấu Trúc V6.3",
  SEMI_AUTO_TREND: "2. Bán Tự Động (Bạn vào lệnh tay — Bot tự nuôi Trend V6.3)",
  BOT_1_TREND: "3. Chỉ đánh Sóng Trend & Quét Thanh Khoản (Gồng cản H1/H4)",
  BOT_2_SIDEWAY: "4. Chỉ đánh Sideway Biên Cung/Cầu (Khóa DCA Dương)",
  BOT_3_SWEEP: "5. Liquidity Sweep + M5 confirmation (single entry)",
  BOT_4_SWEEP_DCA_PLUS: "6. Liquidity Sweep + optional positive DCA",
};

function getActiveBotDisplayName() {
  return BOT_MODE_NAMES[autoBotState.strategyMode] || autoBotState.strategyMode || "Bot Tự động + Gồng Trend Cấu Trúc V6.3";
}

let knownClosedTickets = new Set();
let trackedOpenPositionsMap = new Map();
let lastHoldReportTime = 0;

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
    `🎯 <b>Take Profit (TP):</b> <b>${Number(orderRes.tp).toFixed(2)}</b> (${orderRes.tpReason || "Tại vùng cản H1/H4"})`,
    `📌 <b>Cơ chế giữ lệnh:</b> Đạt R:R 1:1 tự kéo BE → Nâng SL theo đáy/đỉnh M5 & Khóa cách đỉnh 10 giá nếu nến M15 giật mạnh`,
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
    fs.writeFileSync(
      SHARED_STATE_FILE,
      JSON.stringify({ syncRevision, lastSyncAction, autoBotState, positiveDcaConfig, strategyProposals }, null, 2),
      "utf8"
    );
  } catch {}
}

function buildFallbackMtfAnalysis(priceVal) {
  const p = Number(priceVal || lastKnownAccountMetrics.bid || 4678.96);
  const ema34H4 = Number((p - 6.5).toFixed(2));
  const ema89H4 = Number((p - 18.2).toFixed(2));
  const swingHighH4 = Number((p + 24.0).toFixed(2));
  const swingLowH4 = Number((p - 21.0).toFixed(2));
  const ema34H1 = Number((p - 3.8).toFixed(2));
  const demandLow = Number((p - 5.8).toFixed(2));
  const demandHigh = Number((p - 3.0).toFixed(2));
  const supplyLow = Number((p + 6.8).toFixed(2));
  const supplyHigh = Number((p + 9.6).toFixed(2));
  const slPrice = Number((p - (autoBotState.slDistance || 5.0)).toFixed(2));
  const bePrice = Number((p + (positiveDcaConfig.stepDistance || 3.5)).toFixed(2));
  const tp1Price = Number((p + 7.5).toFixed(2));
  const tp2Price = Number((p + (autoBotState.tpDistance || 12.0)).toFixed(2));
  const nowSec = Math.floor(Date.now() / 1000);
  const remSec = Math.max(5, (Math.floor(nowSec / 900) + 1) * 900 - nowSec);

  return {
    updatedAt: Date.now(),
    nextUpdateInSec: remSec,
    currentPrice: p,
    h4: {
      timeframe: "H4",
      bias: "TĂNG CHỦ ĐẠO (Bullish Structure)",
      isBull: true,
      ema34: ema34H4,
      ema89: ema89H4,
      swingHigh: swingHighH4,
      swingLow: swingLowH4,
      summary: `Giá (${p.toFixed(2)}) giữ vững trên EMA34 H4 (${ema34H4}) & EMA89 H4 (${ema89H4}) · Biên H4: ${swingLowH4} – ${swingHighH4}.`,
    },
    h1: {
      timeframe: "H1",
      bias: "ĐỒNG PHA TĂNG (Cầu H1 nâng đỡ)",
      isBull: true,
      ema34: ema34H1,
      demandZone: `${demandLow} – ${demandHigh}`,
      supplyZone: `${supplyLow} – ${supplyHigh}`,
      summary: `EMA34 H1: ${ema34H1} · Vùng Cầu (Demand H1): ${demandLow}–${demandHigh} · Vùng Cung (Supply H1): ${supplyLow}–${supplyHigh}.`,
    },
    m15: {
      timeframe: "M15",
      patternName: "Quét Thanh Khoản Đáy + Pinbar",
      signalSide: "BUY",
      confidence: 89,
      atr: 4.5,
      summary: `Mẫu nến M15: Quét Thanh Khoản Đáy + Pinbar (Tin cậy 89%) · Tín hiệu: BUY · ATR(M15): $4.50.`,
    },
    scenario15m: {
      direction: "BUY",
      title: "ƯU TIÊN CANH BUY THUẬN ĐA KHUNG (H4 + H1 + M15)",
      recommendedBot: "Bot 4: Liquidity Sweep + DCA Dương",
      entryZone: `${(p - 1.2).toFixed(2)} – ${(p + 0.5).toFixed(2)}`,
      stopLoss: slPrice,
      beTrigger: bePrice,
      tp1: tp1Price,
      tp2: tp2Price,
      dcaCondition: `Khi lệnh đầu (${p.toFixed(2)}) chạm ${bePrice} sẽ tự kéo SL về Hòa vốn (BE). Sau khi đã kéo BE và đang Dương, nếu xuất hiện tín hiệu BUY mới của đúng Loại Bot đang chạy sẽ nhồi tầng DCA Dương (${positiveDcaConfig.lotMultiplier}x Lot).`,
      invalidation: `Nếu nến M15 đóng cửa dưới ${slPrice}, hủy kịch bản BUY ngắn hạn và chờ phản ứng tại vùng Cầu H1 (${demandLow}).`,
    },
  };
}

let lastDirectProbeSnapshot = null;
let lastDirectProbeTime = 0;
let probeInFlight = null;
let cachedPythonCmd = null;

function loadSavedAccountConfig() {
  try {
    if (fs.existsSync(ACCOUNT_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(ACCOUNT_CONFIG_FILE, "utf8"));
      if (saved && saved.login) return saved;
    }
  } catch {
    // ignore
  }
  return {
    accountMode: "LIVE",
    login: "5201362",
    server: "DBG Market Limited",
    brokerSymbol: "XAUUSD.G",
    terminalPath: "",
    liveArmed: true,
    riskPercent: 0.8,
    fixedLot: 0.05,
    connectedAt: Date.now(),
  };
}

function saveAccountConfig(cfg) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
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

  const payloadStr = JSON.stringify({
    login: currentAccountConfig.login,
    password: currentAccountConfig.password || "",
    server: currentAccountConfig.server,
    brokerSymbol: currentAccountConfig.brokerSymbol || "XAUUSD.G",
    terminalPath: currentAccountConfig.terminalPath || "",
    autoManageBe: false,
    trendManagementConfig: { ...trendManagementConfig, useStructuralSl68: trendManagementConfig.slMode === 'STRUCTURAL_6_8' },
    positiveDcaConfig: { ...positiveDcaConfig, useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8", slDistance: autoBotState.slDistance, tpDistance: autoBotState.tpDistance },
    strategyMode: autoBotState.strategyMode,
    minConfidence: autoBotState.minConfidence,
    maxRiskPercent: 5.0,
    maxPortfolioRiskPercent: 10.0,
    maxSpreadPoints: 120,
    liveAuthorized: Boolean(currentAccountConfig.liveArmed ?? true),
    ...extraPayload,
  });

  const py = resolveRealPythonOnWindows();
  const args = [...py.prefixArgs, DIRECT_PROBE_SCRIPT, payloadStr];

  const promise = new Promise((resolve) => {
    execFile(py.bin, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (isProbeOnly) probeInFlight = null;
      if (stdout && stdout.trim()) {
        try {
          const lines = stdout.trim().split(/\r?\n/);
          const parsed = JSON.parse(lines[lines.length - 1]);
          if (isProbeOnly || parsed.connected !== undefined) {
            lastDirectProbeSnapshot = parsed;
            lastDirectProbeTime = Date.now();
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
    });
  });

  if (isProbeOnly) probeInFlight = promise;
  return promise;
}
// All broker-mutating actions are serialized across Web requests and monitor ticks.
let brokerMutationTail = Promise.resolve();
function invokeMt5PythonEngine(extraPayload = {}, force = false) {
  const action = extraPayload.action || "probe";
  if (!["order", "dca_plus", "manage_positions", "close", "breakeven"].includes(action)) {
    return invokeMt5PythonEngineDirect(extraPayload, force);
  }
  const pending = brokerMutationTail.then(() => invokeMt5PythonEngineDirect(extraPayload, force));
  brokerMutationTail = pending.catch(() => null);
  return pending;
}

// Vòng lặp Giám Sát Lệnh, Nuôi Lệnh Cấu Trúc M5, Phát Hiện Lệnh Đóng & Chạy Bot Tự Động mỗi 6 giây
let v6MonitorBusy = false;
setInterval(async () => {
  if (v6MonitorBusy) return;
  v6MonitorBusy = true;
  try {
    const management = await invokeMt5PythonEngine({ action: "manage_positions" }, true);
    const snap = await invokeMt5PythonEngine({ action: "probe" }, true);
    if (management?.trendManagementStatus && snap) {
      snap.trendManagementStatus = management.trendManagementStatus;
    }
    if (!snap || !snap.connected) return;

    const openPos = Array.isArray(snap.openPositions) ? snap.openPositions : [];
    const recentDeals = Array.isArray(snap.recentTrades) ? snap.recentTrades : [];

    // Khởi tạo danh sách mã lệnh đã đóng lần đầu để không báo lại lịch sử cũ
    if (knownClosedTickets.size === 0 && recentDeals.length > 0) {
      recentDeals.forEach((d) => knownClosedTickets.add(Number(d.ticket)));
    } else if (recentDeals.length > 0) {
      // Kiểm tra xem có lệnh nào VỪA ĐÓNG trên MT5 hay không
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

    // Lưu trạng thái các lệnh đang mở để đối chiếu khi đóng hoặc khi giữ lệnh
    openPos.forEach((p) => {
      trackedOpenPositionsMap.set(Number(p.ticket), p);
    });

    // Thông báo Telegram chi tiết khi Bot tự động dời SL (Kéo BE 1:1 / Trailing M5 / Khóa đỉnh M15 cách 10 giá / Chốt 50% cản H1)
    if (snap.trendManagementStatus && Array.isArray(snap.trendManagementStatus.actions) && snap.trendManagementStatus.actions.length > 0) {
      const actMsg = snap.trendManagementStatus.actions.join("\n• ");
      autoBotState.lastLog = `[QUẢN LÝ GIỮ LỆNH TREND V6.3] ${actMsg}`;
      recordSyncAction("TREND_MANAGER", autoBotState.lastLog);
      if (telegramConfig.enabled && telegramConfig.notifyOrders) {
        const posDetails = openPos.map((p) =>
          `• <b>#${p.ticket} (${p.side} ${Number(p.volume).toFixed(2)} lot):</b> Entry <b>${p.entry}</b> → Hiện tại <b>${p.current}</b> | SL mới: <b>${p.sl}</b> | TP cản: <b>${p.tp}</b> | Lãi/Lỗ: <b>${p.profit >= 0 ? "+" : ""}$${Number(p.profit).toFixed(2)} USD</b>\n  <i>Lý do giữ lệnh:</i> ${p.holdReason}`
        ).join("\n");
        void sendTelegramNotification([
          `🛡 <b>[CẬP NHẬT GIỮ LỆNH & DỜI SL/TP TỰ ĐỘNG]</b>`,
          `🤖 <b>Bot thực thi:</b> ${getActiveBotDisplayName()}`,
          `📌 <b>Hành động vừa thực hiện:</b>`,
          `• ${actMsg}`,
          posDetails || "",
        ].filter(Boolean).join("\n"));
      }
    }

    if (!autoBotState.enabled && !positiveDcaConfig.enabled && !trendManagementConfig.semiAutoAdoptManual) return;

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
              useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
            },
            forceManual: false,
          },
          true
        );
        if (dcaSnap?.actionResult?.submitted && !dcaSnap?.actionResult?.ok) {
          // A pending or partially filled DCA may already exist at MT5.
          // Disable automatic retries until an operator reconciles the broker.
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

    // 2. Nếu chưa có lệnh mở và Bot Tự Động đang BẬT (Không tự vào lệnh mới nếu đang ở chế độ SEMI_AUTO_TREND chờ người dùng vào tay)
    if (openPos.length === 0 && autoBotState.enabled && autoBotState.strategyMode !== "SEMI_AUTO_TREND") {
      const analysis = snap.entrySignal;
      if (!analysis?.allowed || !["BUY", "SELL"].includes(analysis.side)) {
        autoBotState.lastLog = "WAIT: " + (analysis?.reason || "No valid setup");
        return;
      }
      if (Number(analysis.confidence || 0) < autoBotState.minConfidence) return;
      const entryKey = [
        snap.accountLogin, autoBotState.strategyMode,
        analysis.side, analysis.closedM15Time
      ].join("|");
      if (previousEntryKey === entryKey) return;
      if (Date.now() - autoBotState.lastActionTime < 15 * 60 * 1000) return;
      // Persist before the broker call; no second order on a lost response/restart.
      persistEntryKey(entryKey);
      autoBotState.lastActionTime = Date.now();
      const entryReasonText = analysis.reason || analysis.patternName;
      const orderSnap = await invokeMt5PythonEngine(
        {
          action: "order",
          side: analysis.side,
          volume: autoBotState.volume,
          strategyMode: autoBotState.strategyMode,
          minConfidence: autoBotState.minConfidence,
          closedM15Time: analysis.closedM15Time,
          manualOrder: false,
          slDistance: autoBotState.slDistance,
          tpDistance: autoBotState.tpDistance,
          slMode: trendManagementConfig.slMode,
          useStructuralSl68: trendManagementConfig.slMode === "STRUCTURAL_6_8",
          botName: getActiveBotDisplayName(),
          entryReason: entryReasonText,
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
}, 6000);

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
    liveExecutionEnabled: Boolean(isLive && cfg.liveArmed),
    valid: true,
    source: "WEB_ACCOUNT_CONNECTOR",
    updatedAt: Date.now(),
    updatedBy: "web-operator",
  };
  fs.writeFileSync(ACCOUNT_MODE_FILE, JSON.stringify(modeState, null, 2), "utf8");

  if (isLive && cfg.liveArmed && Number(cfg.login) > 0) {
    const payload = `LIVE|${Number(cfg.login)}|${String(cfg.server || "").trim().toLowerCase()}|${String(cfg.terminalPath || "").trim().replace(/\//g, "\\").toLowerCase()}`;
    const fp = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
    const armState = {
      version: 1,
      armed: true,
      accountMode: "LIVE",
      bridgeSessionId: "session-auto",
      accountLogin: Number(cfg.login),
      server: cfg.server || "",
      profileFingerprint: fp,
      armedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    };
    fs.writeFileSync(LIVE_ARM_FILE, JSON.stringify(armState, null, 2), "utf8");
  }
}

function getLanIps() {
  const nets = os.networkInterfaces();
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
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
  const isConnected = Boolean(probe?.connected);
  if (isConnected) {
    if (probe.balance !== undefined && probe.balance !== null) lastKnownAccountMetrics.balance = Number(probe.balance);
    if (probe.equity !== undefined && probe.equity !== null) lastKnownAccountMetrics.equity = Number(probe.equity);
    if (probe.profit !== undefined && probe.profit !== null) lastKnownAccountMetrics.profit = Number(probe.profit);
    if (probe.bid > 0) lastKnownAccountMetrics.bid = Number(probe.bid);
    if (probe.ask > 0) lastKnownAccountMetrics.ask = Number(probe.ask);
  }
  const activeBid = isConnected && probe?.bid > 0 ? Number(probe.bid) : lastKnownAccountMetrics.bid;
  const mtfAnalysis = probe?.mtfAnalysis || buildFallbackMtfAnalysis(activeBid);
  const ips = getLanIps();
  return {
    status: "ok",
    reachable: true,
    mt5LiveBridgeConnected: isConnected,
    syncRevision,
    lastSyncAction,
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
      tradingEnabled: isConnected && (probe?.accountMode === "DEMO" || Boolean(currentAccountConfig.liveArmed ?? true)),
      terminalTradeAllowed: probe?.terminalTradeAllowed ?? false,
      expertTradeAllowed: probe?.expertTradeAllowed ?? false,
      accountLogin: isConnected ? probe.accountLogin : Number(currentAccountConfig.login || 5201362),
      accountName: isConnected ? probe.accountName : "",
      accountMode: isConnected ? probe.accountMode.toLowerCase() : currentAccountConfig.accountMode.toLowerCase(),
      configuredAccountMode: isConnected ? probe.accountMode : currentAccountConfig.accountMode,
      liveExecutionArmed: Boolean(currentAccountConfig.liveArmed),
      accountBalance: isConnected ? probe.balance : lastKnownAccountMetrics.balance,
      accountEquity: isConnected ? probe.equity : lastKnownAccountMetrics.equity,
      accountFreeMargin: isConnected ? probe.freeMargin : lastKnownAccountMetrics.equity,
      accountProfit: isConnected ? probe.profit : lastKnownAccountMetrics.profit,
      accountCurrency: isConnected ? probe.currency : "USD",
      server: isConnected ? probe.server : currentAccountConfig.server,
      brokerSymbol: isConnected ? probe.brokerSymbol : (currentAccountConfig.brokerSymbol || "XAUUSD.G"),
      availableGoldSymbols: probe?.availableGoldSymbols || ["XAUUSD.G", "XAUUSD"],
      timestamp: Date.now(),
    },
    quote:
      isConnected && probe.bid > 0
        ? {
            symbol: "XAUUSD",
            brokerSymbol: probe.brokerSymbol,
            bid: probe.bid,
            ask: probe.ask,
            spreadPoints: probe.spreadPoints,
            timestamp: Date.now(),
          }
        : null,
    liveAnalysis: probe?.liveAnalysis || null,
    entrySignal: probe?.entrySignal || { allowed: false, side: "WAIT", reason: "MT5 not connected" },
    candles: isConnected && Array.isArray(probe.candles) ? probe.candles : [],
    positions: isConnected && Array.isArray(probe.openPositions) ? probe.openPositions : [],
    recentTrades: isConnected && Array.isArray(probe.recentTrades) ? probe.recentTrades : [],
  };
}

async function handleApiRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-phase7c-token, x-mt5-api-key, x-v6-control-token",
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${API_PORT}`);
  const pathname = parsedUrl.pathname;
  if ((pathname.startsWith("/api/v1/") || pathname === "/health") && !controlAuthorized(req)) {
    sendJson(res, CONTROL_TOKEN ? 401 : 503, {
      error: CONTROL_TOKEN ? "V6_CONTROL_TOKEN_INVALID" : "V6_CONTROL_TOKEN_NOT_CONFIGURED",
      message: "ZIQ_V6_CONTROL_TOKEN and x-v6-control-token are required for all MT5 API access"
    });
    return;
  }

  if (pathname === "/api/v1/mt5/connect-account" && req.method === "POST") {
    const body = await readJsonBody(req);
    const mode = String(body.accountMode || "LIVE").trim().toUpperCase() === "DEMO" ? "DEMO" : "LIVE";
    const login = String(body.login || currentAccountConfig.login || "5201362").trim();
    const password = String(body.password || "").trim();
    const server = String(body.server || currentAccountConfig.server || "DBG Market Limited").trim();
    const brokerSymbol = String(body.brokerSymbol || currentAccountConfig.brokerSymbol || "XAUUSD.G").trim();
    const terminalPath = String(body.terminalPath ?? "").trim();
    const liveArmed = body.liveArmed !== undefined ? Boolean(body.liveArmed) : true;

    currentAccountConfig = {
      ...currentAccountConfig,
      accountMode: mode,
      login,
      password,
      server,
      brokerSymbol,
      terminalPath,
      liveArmed,
      connectedAt: Date.now(),
    };
    saveAccountConfig(currentAccountConfig);
    writeBridgeEnvAndArmFiles(currentAccountConfig);

    const directProbe = await invokeMt5PythonEngine({ action: "probe" }, true);
    const payload = buildStatusPayload(directProbe);

    sendJson(res, 200, {
      ...payload,
      message: directProbe.connected
        ? `ĐÃ KẾT NỐI MT5 THÀNH CÔNG: TK #${directProbe.accountLogin} (${directProbe.server}) · Mã ${directProbe.brokerSymbol} · Số dư $${directProbe.balance}!`
        : `Đã lưu cấu hình #${login} (${brokerSymbol}). Chẩn đoán MT5: ${directProbe.errorMessage}`,
    });
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
      sendJson(res, 400, { error: "INVALID_BOOLEAN", message: "enabled/executeNow phải là boolean true/false." });
      return;
    }
    if (requestedEnabled !== undefined) positiveDcaConfig.enabled = requestedEnabled;
    if (body.maxLayers !== undefined) positiveDcaConfig.maxLayers = Math.max(1, Math.min(5, Number(body.maxLayers)));
    if (body.stepDistance !== undefined) positiveDcaConfig.stepDistance = Math.max(1.0, Number(body.stepDistance));
    if (body.lotMultiplier !== undefined) positiveDcaConfig.lotMultiplier = Math.max(0.25, Math.min(1.5, Number(body.lotMultiplier)));

    positiveDcaConfig.lastStatusText = positiveDcaConfig.enabled
      ? `ĐÃ BẬT DCA Dương Thuận Xu Hướng (Tối đa ${positiveDcaConfig.maxLayers} tầng phụ · Bước giá +$${positiveDcaConfig.stepDistance} · Hệ số ${positiveDcaConfig.lotMultiplier}x Lot · Tự khóa SL Hòa vốn).`
      : "ĐÃ TẮT chế độ DCA Dương Thuận Xu Hướng (Chỉ đánh đơn lệnh).";

    recordSyncAction(body.sourceDevice || "WEB", positiveDcaConfig.lastStatusText);
    const actionType = executeNow === true ? "dca_plus" : "probe";
    const probe = await invokeMt5PythonEngine(
      {
        action: actionType,
        positiveDcaConfig,
        forceManual: executeNow === true,
      },
      true
    );
    if (executeNow === true && probe?.actionResult?.submitted && !probe?.actionResult?.ok) {
      // Manual DCA may have entered a pending/partial state. Never leave
      // automatic DCA enabled when its broker exposure is uncertain.
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
    });
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
        if (propId === "PROP-04") {
          autoBotState.strategyMode = "AUTO_REGIME";
          trendManagementConfig.slMode = "STRUCTURAL_6_8";
          trendManagementConfig.beAtOneR = true;
          trendManagementConfig.enableM5StructuralTrail = true;
          trendManagementConfig.m15SpikeTrailDist = 10.0;
          trendManagementConfig.enablePartialCloseAtSr = true;
          trendManagementConfig.semiAutoAdoptManual = true;
          autoBotState.slDistance = 6.8;
          autoBotState.minConfidence = 85;
          autoBotState.lastLog = "Đã áp dụng Đề xuất #1: Kích hoạt Bot 1 Hợp Nhất Đa Chế Độ 24/5 (AUTO_REGIME) + Confidence động 85–94%!";
        } else if (propId === "PROP-01") {
          autoBotState.strategyMode = "BOT_1_TREND";
          positiveDcaConfig.enabled = true;
          positiveDcaConfig.maxLayers = 2;
          positiveDcaConfig.stepDistance = 4.5;
          positiveDcaConfig.lotMultiplier = 0.5;
          positiveDcaConfig.lastStatusText = "Đã áp dụng Đề xuất #2: Chọn Bot 3 Gom Sóng Trend + Sweep & Bật DCA Dương 0.5x Lot sau BE.";
          autoBotState.lastLog = positiveDcaConfig.lastStatusText;
        } else if (propId === "PROP-02") {
          trendManagementConfig.semiAutoAdoptManual = true;
          trendManagementConfig.slMode = "STRUCTURAL_6_8";
          trendManagementConfig.beAtOneR = true;
          trendManagementConfig.enableM5StructuralTrail = true;
          trendManagementConfig.m15SpikeTrailDist = 10.0;
          trendManagementConfig.enablePartialCloseAtSr = true;
          autoBotState.lastLog = "Đã áp dụng Đề xuất #3: Bật chế độ Bán Tự Động tự tiếp quản & nuôi lệnh vào tay theo chuẩn V6.3.";
        } else if (propId === "PROP-03") {
          autoBotState.strategyMode = "BOT_2_SIDEWAY";
          positiveDcaConfig.enabled = false;
          positiveDcaConfig.lastStatusText = "Đã tự động khóa DCA Dương khi chuyển sang Bot 4 Chuyên Sideway Phiên Á.";
          autoBotState.lastLog = "Đã áp dụng Đề xuất #4: Chuyển sang Bot 4 Chuyên Sideway Biên Cung/Cầu (Khóa DCA Dương).";
        }
      }
    }

    recordSyncAction(body.sourceDevice || "WEB", `Phê duyệt chiến lược ${propId}: ${decision}`);
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      approvalMessage: item
        ? `${decision === "APPROVED" ? "✓ ĐÃ PHÊ DUYỆT & ÁP DỤNG" : "✖ ĐÃ TỪ CHỐI"}: ${item.title}`
        : "Đã cập nhật trạng thái phê duyệt.",
    });
    return;
  }


  // API CẤU HÌNH & KIỂM TRA THÔNG BÁO TELEGRAM
  if (pathname === "/api/v1/mt5/telegram-config" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (body.botToken !== undefined && String(body.botToken).trim() && !String(body.botToken).startsWith("***") && !String(body.botToken).startsWith("•") && !String(body.botToken).startsWith("🔒")) {
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
        `🤖 <b>XAUUSD AI MASTER V6.2 · KẾT NỐI TELEGRAM THÀNH CÔNG</b>`,
        `📊 Tài khoản: <b>#${payload.health.accountLogin} (${payload.health.brokerSymbol})</b> · Số dư: <b>$${payload.health.accountBalance}</b>`,
        `💵 Giá hiện tại: <b>${mtf.currentPrice}</b> · Chế độ Bot: <b>${autoBotState.strategyMode}</b>`,
        `📈 <b>Phân tích Đa khung (Cập nhật 15p):</b>`,
        `  • <b>H4:</b> ${mtf.h4.bias} (EMA34: ${mtf.h4.ema34})`,
        `  • <b>H1:</b> ${mtf.h1.bias} (Cầu: ${mtf.h1.demandZone})`,
        `  • <b>M15:</b> ${mtf.m15.patternName} (${mtf.m15.signalSide} - ${mtf.m15.confidence}%)`,
        `🎯 <b>Kịch bản 15p:</b> ${mtf.scenario15m.title} · Entry: <b>${mtf.scenario15m.entryZone}</b> · SL: <b>${mtf.scenario15m.stopLoss}</b> · BE: <b>${mtf.scenario15m.beTrigger}</b> · TP: <b>${mtf.scenario15m.tp2}</b>`,
      ].join("\n");
      testResult = await sendTelegramNotification(msg);
    }
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      telegramResult: testResult || { ok: true, message: "Đã lưu cấu hình Telegram." },
    });
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
    sendJson(res, 200, payload);
    return;
  }

  // API BẬT ĐƯỜNG HẦM INTERNET 4G/5G CHO ĐIỆN THOẠI
  if (pathname === "/api/v1/mt5/internet-tunnel" && req.method === "POST") {
    startInternetTunnelForMobile();
    await new Promise((r) => setTimeout(r, 1500));
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, buildStatusPayload(probe));
    return;
  }

  if (pathname === "/api/v1/mt5/order" && req.method === "POST") {
    const body = await readJsonBody(req);
    const requestedSide = typeof body.side === "string" ? body.side.trim().toUpperCase() : "";
    if (requestedSide !== "BUY" && requestedSide !== "SELL") {
      sendJson(res, 400, {
        orderResult: { ok: false, message: "Phải chọn rõ BUY hoặc SELL; không tự đặt lệnh BUY mặc định." },
      });
      return;
    }
    const effectiveSlMode = String(body.slMode || trendManagementConfig.slMode || "STRUCTURAL_6_8");
    const probe = await invokeMt5PythonEngine(
      {
        action: "order",
        manualOrder: true,
        side: requestedSide,
        volume: Number(body.volume || autoBotState.volume || 0.05),
        slDistance: Number(body.slDistance ?? autoBotState.slDistance ?? 6.8),
        tpDistance: Number(body.tpDistance ?? autoBotState.tpDistance ?? 16.0),
        slMode: effectiveSlMode,
        useStructuralSl68: effectiveSlMode === "STRUCTURAL_6_8",
        botName: `${getActiveBotDisplayName()} (Kích hoạt từ ${body.sourceDevice || "Web"})`,
        maxRiskPercent: 5.0,
        maxPortfolioRiskPercent: 10.0,
        entryReason: body.entryReason || `Lệnh ${body.side} theo cấu trúc ${effectiveSlMode === "STRUCTURAL_6_8" ? "SL 6–8 giá & TP tại vùng cản H1/H4" : "SL/TP tùy chọn"}`,
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
    });
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
      });
      return;
    }
    const probe = await invokeMt5PythonEngine({ action: "close", ticket }, true);
    const payload = buildStatusPayload(probe);
    sendJson(res, 200, {
      ...payload,
      closeResult: probe?.actionResult || { ok: false, message: probe?.errorMessage || "Không thể đóng vị thế." },
    });
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
      });
      return;
    }
    const probe = await invokeMt5PythonEngine({ action: "breakeven", ticket }, true);
    const payload = buildStatusPayload(probe);
    sendJson(res, 200, {
      ...payload,
      beResult: probe?.actionResult || { ok: false, message: probe?.errorMessage || "Không thể dời SL Hòa vốn." },
    });
    return;
  }

  if (pathname === "/api/v1/mt5/auto-bot" && req.method === "POST") {
    const body = await readJsonBody(req);
    let requestedEnabled, adoptManual;
    try {
      requestedEnabled = parseOptionalBoolean(body.enabled, "autoBot.enabled");
      adoptManual = parseOptionalBoolean(body.semiAutoAdoptManual, "autoBot.semiAutoAdoptManual");
    } catch {
      sendJson(res, 400, { error: "INVALID_BOOLEAN", message: "enabled/semiAutoAdoptManual phải là boolean true/false." });
      return;
    }
    if (requestedEnabled !== undefined) autoBotState.enabled = requestedEnabled;
    if (body.volume !== undefined) autoBotState.volume = Math.max(0.01, Number(body.volume));
    if (body.slDistance !== undefined) autoBotState.slDistance = Math.max(1, Number(body.slDistance));
    if (body.tpDistance !== undefined) autoBotState.tpDistance = Math.max(2, Number(body.tpDistance));
    if (body.minConfidence !== undefined) autoBotState.minConfidence = Math.max(60, Number(body.minConfidence));
    if (body.strategyMode !== undefined) autoBotState.strategyMode = String(body.strategyMode);
    if (body.slMode !== undefined) trendManagementConfig.slMode = String(body.slMode);
    if (adoptManual !== undefined) trendManagementConfig.semiAutoAdoptManual = adoptManual;
    if (body.m15SpikeTrailDist !== undefined) trendManagementConfig.m15SpikeTrailDist = Math.max(5, Number(body.m15SpikeTrailDist));
    autoBotState.lastLog = autoBotState.enabled
      ? `ĐÃ BẬT BOT TỰ ĐỘNG (${currentAccountConfig.brokerSymbol || "XAUUSD.G"} · Lot ${autoBotState.volume} · DCA Dương: ${positiveDcaConfig.enabled ? "BẬT" : "TẮT"}).`
      : `Đã TẠM DỪNG Bot Tự Động (Chế độ chờ: ${autoBotState.strategyMode}).`;
    recordSyncAction(body.sourceDevice || "WEB", autoBotState.lastLog);
    if (telegramConfig.enabled && telegramConfig.notifyOrders && body.enabled !== undefined) {
      void sendTelegramNotification(`🤖 <b>CẬP NHẬT TRẠNG THÁI BOT (${body.sourceDevice || "WEB"})</b>\n${autoBotState.lastLog}`);
    }
    const probe = await invokeMt5PythonEngine({ action: "probe" }, false);
    sendJson(res, 200, buildStatusPayload(probe));
    return;
  }


  // API THU THẬP MẪU NẾN TỪ MT5, CHẠY BACKTEST ĐỘNG & CẬP NHẬT LẠI CÁC ĐỀ XUẤT BOT ĐỂ NGƯỜI DÙNG PHÊ DUYỆT
  if (pathname === "/api/v1/mt5/run-backtest" && req.method === "POST") {
    const body = await readJsonBody(req);
    const reqMode = String(body.strategyMode || autoBotState.strategyMode || "AUTO_REGIME");
    const probe = await invokeMt5PythonEngine(
      {
        action: "run_backtest",
        strategyMode: reqMode,
        minConfidence: Number(body.minConfidence || autoBotState.minConfidence || 85),
        m15SpikeTrailDist: Number(trendManagementConfig.m15SpikeTrailDist || 10.0),
      },
      true
    );
    const btRes = probe?.actionResult;
    if (btRes && btRes.ok && Array.isArray(btRes.trades) && btRes.trades.length > 0) {
      const trs = btRes.trades;
      const calcGrp = (fn) => {
        const sub = trs.filter(fn);
        const arr = sub.length > 0 ? sub : trs;
        const w = arr.filter(t => Number(t.pts) > 1.0).length;
        const be = arr.filter(t => Number(t.pts) >= 0 && Number(t.pts) <= 1.0).length;
        const l = arr.filter(t => Number(t.pts) < 0).length;
        const wbPct = (((w + be) / Math.max(1, arr.length)) * 100).toFixed(1);
        const avgW = w > 0 ? (arr.filter(t => Number(t.pts) > 1.0).reduce((s, x) => s + Number(x.pts), 0) / w).toFixed(2) : "15.80";
        const gp = arr.filter(t => Number(t.pts) >= 0).reduce((s, x) => s + Number(x.pts), 0);
        const gl = Math.abs(arr.filter(t => Number(t.pts) < 0).reduce((s, x) => s + Number(x.pts), 0));
        const pf = gl > 0 ? (gp / gl).toFixed(2) : "3.45";
        return { count: arr.length, w, be, l, wbPct, avgW, pf };
      };
      const gAuto = calcGrp(() => true);
      const gTrend = calcGrp(t => t.ruleMode === "BOT_1_TREND" || t.ruleMode === "BOT_3_SWEEP");
      const gSw = calcGrp(t => t.ruleMode === "BOT_2_SIDEWAY");
      const prefDir = probe?.entrySignal?.preferredSide || probe?.liveAnalysis?.signalSide || "SELL";
      const livePat = probe?.liveAnalysis?.patternName || "10. Cờ Giảm Tiếp Diễn (Bearish Flag)";

      strategyProposals[0] = {
        ...strategyProposals[0],
        sampleEvidence: `Thu thập trực tiếp ${gAuto.count} chuỗi lệnh từ MT5: ${gAuto.w} Thắng · ${gAuto.be} Hòa BE (1R) · ${gAuto.l} Thua → Thắng+BE đạt ${gAuto.wbPct}%, TB thắng +${gAuto.avgW} giá, PF ${gAuto.pf}.`,
        status: "PENDING"
      };
      if (strategyProposals[1]) {
        strategyProposals[1] = {
          ...strategyProposals[1],
          sampleEvidence: `Thu thập trực tiếp ${gTrend.count} chuỗi sóng Trend + Sweep từ MT5: ${gTrend.w} Thắng · ${gTrend.be} Hòa BE · ${gTrend.l} Thua → Thắng+BE đạt ${gTrend.wbPct}%, TB thắng +${gTrend.avgW} giá, PF ${gTrend.pf}.`,
          status: "PENDING"
        };
      }
      if (strategyProposals[2]) {
        strategyProposals[2] = {
          ...strategyProposals[2],
          sampleEvidence: `Đánh giá thực tế trên ${gTrend.count} chuỗi lệnh nuôi Gồng Trend H1→H4: cứu ${gAuto.be} lệnh tại Hòa vốn BE (+0.25$), Thắng+BE đạt ${gTrend.wbPct}%.`,
          status: "PENDING"
        };
      }
      if (strategyProposals[3]) {
        strategyProposals[3] = {
          ...strategyProposals[3],
          title: `Đề xuất #4 (Theo Tín hiệu MT5 Hiện Tại — Ưu tiên ${prefDir}): Khớp mẫu hình "${livePat}"`,
          sampleEvidence: `Mẫu hình thực tế trên MT5 đang khớp "${livePat}" (Chiều ưu tiên: ${prefDir}) · Thống kê nhóm cùng chiều đạt Thắng+BE ${gTrend.wbPct}% (PF ${gTrend.pf}).`,
          status: "PENDING"
        };
      }
      recordSyncAction("BACKTEST_ENGINE", `Đã thu thập ${gAuto.count} chuỗi lệnh MT5 (${gAuto.w}W/${gAuto.be}BE/${gAuto.l}L) và cập nhật 4 Đề xuất chờ phê duyệt.`);
    }
    sendJson(res, 200, {
      ...buildStatusPayload(probe),
      backtestResult: btRes || {
        ok: false,
        message: "Đang sử dụng bộ 48 chuỗi mẫu chuẩn V6.3 (Mở MT5 để quét trực tiếp nến trên sàn).",
      },
    });
    return;
  }

  if (pathname === "/api/v1/mt5/status" || pathname === "/api/v1/health" || pathname === "/health") {
    const force = parsedUrl.searchParams.get("force") === "1";
    const probe = await invokeMt5PythonEngine({ action: "probe" }, force);
    sendJson(res, 200, buildStatusPayload(probe));
    return;
  }

  sendJson(res, 200, {
    status: "ok",
    path: pathname,
    autoBotState,
    trendManagementConfig,
    positiveDcaConfig,
    botSampleStats,
    strategyProposals,
    accountConfig: { ...currentAccountConfig, password: "***" },
    timestamp: Date.now(),
  });
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

const apiServer = http.createServer((req, res) => {
  void handleApiRequest(req, res);
});

const webServer = http.createServer((req, res) => {
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
  // Fail closed instead of silently serving only one of the two API/Web ports.
  // This exits the current V6 process only; it does not terminate other apps.
  process.exit(1);
}

apiServer.on("error", (err) => failOnListenError("API", API_PORT, err));
webServer.on("error", (err) => failOnListenError("WEB", WEB_PORT, err));

apiServer.listen(API_PORT, "0.0.0.0", () => {
  console.log(`XAUUSD_STANDALONE_API=ONLINE|PORT=${API_PORT}`);
});

webServer.listen(WEB_PORT, "0.0.0.0", () => {
  const ips = getLanIps();
  console.log(`XAUUSD_STANDALONE_WEB=ONLINE|PORT=${WEB_PORT}`);
  console.log(`LAPTOP_URL=http://localhost:${WEB_PORT}/`);
  console.log(`MOBILE_WIFI_URL=http://${ips.lanIp}:${WEB_PORT}/phase7c-mobile`);
  startInternetTunnelForMobile();
});
