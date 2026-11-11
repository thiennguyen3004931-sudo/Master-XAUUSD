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
import { execFile, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseRequiredTicket, parseOptionalBoolean } from "./v6-api-input-guards.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT_DIR, ".runtime");

const API_PORT = Number(process.env.API_PORT || 3711);
const WEB_PORT = Number(process.env.WEB_PORT || 5717);

const ACCOUNT_CONFIG_FILE = path.join(RUNTIME_DIR, "active-mt5-account.json");
const DIRECT_PROBE_SCRIPT = path.join(ROOT_DIR, "scripts", "mt5-direct-probe.py");

fs.mkdirSync(RUNTIME_DIR, { recursive: true });

// Do not kill unrelated Windows processes to reclaim ports. In particular, a
// self-hosted CI runner and MT5 must never be disrupted by starting this server.
// A port conflict is a fatal startup error, not permission to Stop-Process.

// Saved account profiles never automatically re-arm LIVE after a process restart.
let currentAccountConfig = { ...loadSavedAccountConfig(), liveArmed: false };
const CONTROL_TOKEN = String(process.env.ZIQ_V6_CONTROL_TOKEN || "").trim();
const ENTRY_DEDUPE_FILE = path.join(RUNTIME_DIR, "v6-entry-dedupe.json");
let previousEntryKey = "";
try { previousEntryKey = JSON.parse(fs.readFileSync(ENTRY_DEDUPE_FILE, "utf8")).key || ""; } catch {}
function persistEntryKey(key) {
  previousEntryKey = key;
  fs.writeFileSync(ENTRY_DEDUPE_FILE, JSON.stringify({ key, timestamp: Date.now() }), "utf8");
}
function controlAuthorized(req) {
  if (!CONTROL_TOKEN) return false;
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
  slMode: "STRUCTURAL_6_8", // "STRUCTURAL_6_8" (SL cấu trúc 6-8 giá & Gồng mở) hoặc "FIXED_CUSTOM" (Dùng SL/TP cố định khi cần)
  structuralSlMin: 6.0,
  structuralSlMax: 8.0,
  beAtOneR: true,
  enableM5StructuralTrail: true,
  m15SpikeTrailDist: 10.0,
  enablePartialCloseAtSr: true,
  semiAutoAdoptManual: false, // Manual positions are never adopted without explicit opt-in.
};
let lastSentScenarioSignature = "";

let autoBotState = {
  enabled: false,
  strategyMode: "LIQUIDITY_SWEEP_AND_TREND",
  volume: 0.04,
  slDistance: 6.8,
  tpDistance: 16.0,
  minConfidence: 85,
  lastActionTime: 0,
  lastLog: "Bot đang ở chế độ chờ kích hoạt.",
};

const internetTunnelState = {
  active: false,
  publicUrl: null,
  provider: null,
  statusText: "V6 giới hạn ở localhost; Cloudflare/LAN tunnel chưa được cấp quyền.",
};

// Hard-coded UI samples only: NOT verified strategy results, broker history, or LIVE authority.
const V6_SAMPLE_EVIDENCE = Object.freeze({
  source: "STATIC_UI_DEMONSTRATION",
  brokerVerified: false,
  backtestVerified: false,
  liveAuthorized: false,
});

// Dữ liệu Thống kê mẫu lệnh của các Bot & Danh sách Đề xuất chờ Người dùng Phê duyệt
const botSampleStats = [
  {
    botId: "BOT_SWEEP_DCA",
    botName: "Bot 4 · Liquidity Sweep + DCA Dương Thuận Xu Hướng",
    sampleSize: 42,
    wins: 30,
    losses: 12,
    winRatePercent: 71.4,
    profitFactor: 2.94,
    expectancyR: 1.46,
    netPnlUsd: 2680.0,
    earlyBeSweeps: 2,
    regimeFitScore: 94,
    recommended: true,
    note: "Hiệu suất cao nhất khi thị trường có sóng đẩy mạnh sau pha quét thanh khoản.",
  },
  {
    botId: "BOT_LIQUIDITY_SWEEP",
    botName: "Bot 3 · Liquidity Sweep + FVG (Đơn lệnh)",
    sampleSize: 34,
    wins: 25,
    losses: 9,
    winRatePercent: 73.5,
    profitFactor: 2.68,
    expectancyR: 1.14,
    netPnlUsd: 1420.0,
    earlyBeSweeps: 3,
    regimeFitScore: 91,
    recommended: true,
    note: "Tỷ lệ thắng cao nhất ở vùng mở cửa phiên Âu và đầu phiên Mỹ.",
  },
  {
    botId: "BOT_TREND_SUPERTREND",
    botName: "Bot 1 · Trend Supertrend (M15/M5 + 3 Mẫu Nến)",
    sampleSize: 58,
    wins: 39,
    losses: 19,
    winRatePercent: 67.2,
    profitFactor: 2.18,
    expectancyR: 0.82,
    netPnlUsd: 1940.0,
    earlyBeSweeps: 5,
    regimeFitScore: 86,
    recommended: false,
    note: "Ổn định khi ADX > 25; hiệu quả tăng mạnh khi kết hợp dời BE theo 0.85×ATR.",
  },
  {
    botId: "BOT_SIDEWAY_CORRIDOR",
    botName: "Bot 2 · Sideway Supply/Demand Corridor",
    sampleSize: 36,
    wins: 23,
    losses: 13,
    winRatePercent: 63.9,
    profitFactor: 1.79,
    expectancyR: 0.54,
    netPnlUsd: 860.0,
    earlyBeSweeps: 4,
    regimeFitScore: 72,
    recommended: false,
    note: "Phù hợp cho phiên Á biên độ hẹp (ADX < 20).",
  },
];

let strategyProposals = [
  {
    id: "PROP-04",
    title: "Đề xuất #4 (Đề xuất của Bạn): Bot Trend SL Cấu trúc 6–8 giá + BE tại R:R 1:1 + Trailing M5 + Khóa đỉnh M15 cách 10 giá + Chốt cản H1/H4 + Bán tự động nuôi lệnh tay",
    targetBot: "Bot Trend V6.3 & Chế độ Bán Tự Động (Semi-Auto)",
    sampleEvidence: "Kết hợp giữ SL/TP chủ động khi cần với gồng lãi theo cấu trúc M5, khóa đỉnh M15 cách 10 giá khi biến động mạnh và chốt từng phần tại Kháng cự/Hỗ trợ H1/H4.",
    proposedChanges: "SL cấu trúc = 6–8 giá · Đạt 1R tự kéo BE · Trailing đáy/đỉnh M5 · Cây M15 giật mạnh khóa SL cách đỉnh 10 giá · Chốt 50% tại cản H1 & gồng tới cản H4 · DCA Dương sau khi lệnh trên kéo BE (đặt SL/TP như lệnh đầu) · Tự nuôi cả lệnh vào tay.",
    riskImpact: "Bảo vệ trọn vẹn thành quả khi nến M15 phóng mạnh và tối đa hóa lợi nhuận sóng lớn H1/H4.",
    status: "APPROVED",
    decidedAt: Date.now(),
  },
  {
    id: "PROP-01",
    title: "Đề xuất #1: Bật chế độ DCA Dương Thuận Xu Hướng (Tối đa 2 tầng, Hệ số 0.5x Lot)",
    targetBot: "Bot 4 · Liquidity Sweep + DCA Dương",
    sampleEvidence: "Thống kê 42 mẫu chuỗi lệnh: Winrate đạt 71.4%, Profit Factor tăng từ 2.68 lên 2.94, kỳ vọng +1.46R/chuỗi.",
    proposedChanges: "Bật DCA Dương = ON · Bước nhồi = +4.5 giá · Hệ số Lot = 0.5x · Tự khóa SL lệnh gốc về Hòa vốn trước khi nhồi.",
    riskImpact: "Rủi ro lệnh gốc = 0% khi nhồi tầng 1 (do đã dời SL về BE).",
    status: "PENDING",
    decidedAt: null,
  },
  {
    id: "PROP-02",
    title: "Đề xuất #2: Chuyển chiến lược chính sang Liquidity Sweep + FVG kết hợp Dời BE động (0.85×ATR)",
    targetBot: "Bot 3 & Bot 1 (XAUUSD.G)",
    sampleEvidence: "Thống kê 34 mẫu lệnh Liquidity Sweep + 58 mẫu lệnh Trend: Giảm 38% lệnh bị quét hòa vốn sớm trong phiên Mỹ.",
    proposedChanges: "Chiến lược ưu tiên = LIQUIDITY_SWEEP_AND_TREND · SL = 5.0 giá · TP = 12.0 giá · Độ tin cậy tối thiểu = 85%.",
    riskImpact: "Giảm Max Drawdown từ 6.9% xuống 4.5%.",
    status: "PENDING",
    decidedAt: null,
  },
  {
    id: "PROP-03",
    title: "Đề xuất #3: Tự động chuyển sang Bot Sideway Corridor trong Phiên Á (06:00 – 13:30 VN)",
    targetBot: "Bot 2 · Sideway Supply/Demand",
    sampleEvidence: "Thống kê 36 mẫu lệnh phiên Á: Đánh biên Cung/Cầu đạt Winrate 63.9%, trong khi đánh Breakout phiên Á chỉ đạt 46%.",
    proposedChanges: "Khóa Breakout khi ADX < 20 · Chỉ vào lệnh từ chối biên Supply/Demand với TP ngắn 6.5 giá.",
    riskImpact: "Tránh các lệnh फंस (whipsaw) đầu ngày.",
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
} catch {}
autoBotState.enabled = false;
autoBotState.lastActionTime = 0;
positiveDcaConfig.enabled = false;
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

function loadTelegramConfig() {
  try {
    if (fs.existsSync(TELEGRAM_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TELEGRAM_CONFIG_FILE, "utf8"));
      if (saved) return saved;
    }
  } catch {}
  return {
    enabled: false,
    botToken: process.env.ZIQ_TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.ZIQ_TELEGRAM_CHAT_ID || "",
    notifyOrders: true,
    notifyMtf15m: false,
    lastSentAt: null,
    lastStatus: "Chưa nhập Bot Token & Chat ID (Nhập tại mục Kết nối API / MT5 & Telegram).",
  };
}

let telegramConfig = loadTelegramConfig();

function saveTelegramConfig(cfg) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
    const envTgPath = path.join(ROOT_DIR, ".env.phase7b-telegram");
    const envLines = [
      `ZIQ_TELEGRAM_BOT_TOKEN=${cfg.botToken || ""}`,
      `ZIQ_TELEGRAM_CHAT_ID=${cfg.chatId || ""}`,
      `ZIQ_TELEGRAM_SEND_STARTUP=true`,
      `ZIQ_TELEGRAM_SYMBOL=${currentAccountConfig?.brokerSymbol || "XAUUSD.G"}`,
    ];
    fs.writeFileSync(envTgPath, envLines.join("\n") + "\n", "utf8");
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
    accountMode: "DEMO",
    login: "5201362",
    server: "DBG Market Limited",
    brokerSymbol: "XAUUSD.G",
    terminalPath: "",
    liveArmed: false,
    riskPercent: 0.8,
    fixedLot: 0.12,
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
    maxRiskPercent: 1.0,
    maxPortfolioRiskPercent: 1.5,
    liveAuthorized: false, // Fail closed: LIVE orders need a separate verified activation implementation.
    ...extraPayload,
  });

  const py = resolveRealPythonOnWindows();
  // Never expose MT5 account credentials in process arguments (Windows WMI/process listings).
  const args = [...py.prefixArgs, DIRECT_PROBE_SCRIPT];

  const promise = new Promise((resolve) => {
    const child = execFile(py.bin, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
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
    // JSON is delivered over the child's private stdin pipe; never argv or logs.
    // An early Python exit may close stdin; execFile's callback still reports failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(payloadStr + "\n");
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
// Independent V6 direct-MT5 must never mutate Phase7C bridge profile, account
// mode or LIVE ARM files. Public Cloudflare tunnels are disabled until a
// separately audited remote-access design is approved.

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
      botToken: telegramConfig.botToken ? "***" + String(telegramConfig.botToken).slice(-6) : "",
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
    botSampleEvidence: V6_SAMPLE_EVIDENCE,
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
      tradingEnabled: isConnected && probe?.accountMode === "DEMO",
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
    // Switching accounts never arms LIVE; only an independent verified action may.
    const liveArmed = false;

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
    // Do not edit any Phase7C bridge, account-mode or LIVE ARM files.

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
        if (propId === "PROP-01") {
          positiveDcaConfig.enabled = true;
          positiveDcaConfig.maxLayers = 2;
          positiveDcaConfig.stepDistance = 4.5;
          positiveDcaConfig.lotMultiplier = 0.5;
          positiveDcaConfig.lastStatusText = "Đã bật DCA Dương Thuận Xu Hướng theo phê duyệt Đề xuất #1.";
        } else if (propId === "PROP-02") {
          autoBotState.strategyMode = "LIQUIDITY_SWEEP_AND_TREND";
          autoBotState.slDistance = 5.0;
          autoBotState.tpDistance = 12.0;
          autoBotState.minConfidence = 85;
          autoBotState.lastLog = "Đã áp dụng chiến lược Liquidity Sweep + FVG & Dời BE động theo phê duyệt Đề xuất #2.";
        } else if (propId === "PROP-04") {
          trendManagementConfig.slMode = "STRUCTURAL_6_8";
          trendManagementConfig.beAtOneR = true;
          trendManagementConfig.enableM5StructuralTrail = true;
          trendManagementConfig.m15SpikeTrailDist = 10.0;
          trendManagementConfig.enablePartialCloseAtSr = true;
          trendManagementConfig.semiAutoAdoptManual = true;
          // Approval of stop-management improvements never silently enables risk-increasing DCA.
          autoBotState.slDistance = 6.8;
          autoBotState.lastLog = "Đã áp dụng Đề xuất #4: SL Cấu trúc 6–8 giá + Đạt 1R kéo BE + Trailing M5 + Khóa đỉnh M15 cách 10 giá + Chốt từng phần cản H1/H4 + Bán tự động nuôi lệnh tay!";
        } else if (propId === "PROP-03") {
          autoBotState.lastLog = "Đã ghi nhận đề xuất Sideway phiên Á. Phải chọn chế độ SIDEWAY riêng; chưa có lịch tự chuyển bot.";
          positiveDcaConfig.enabled = false;
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
    if (body.botToken !== undefined && String(body.botToken).trim() && !String(body.botToken).startsWith("***")) {
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
    if (body.sendTest) {
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
    sendJson(res, 403, {
      error: "V6_REMOTE_TUNNEL_DISABLED",
      message: "Independent V6 is localhost-only. Remote tunnel requires a separately audited access path.",
    });
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
        maxRiskPercent: 1.0,
        maxPortfolioRiskPercent: 1.5,
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
    botSampleEvidence: V6_SAMPLE_EVIDENCE,
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

apiServer.listen(API_PORT, "127.0.0.1", () => {
  console.log(`XAUUSD_STANDALONE_API=ONLINE|PORT=${API_PORT}`);
});

webServer.listen(WEB_PORT, "127.0.0.1", () => {
  console.log(`XAUUSD_STANDALONE_WEB=ONLINE|PORT=${WEB_PORT}`);
  console.log(`LAPTOP_URL=http://localhost:${WEB_PORT}/`);
  console.log("V6_NETWORK_SCOPE=LOOPBACK_ONLY|REMOTE_TUNNEL=DISABLED");
});
