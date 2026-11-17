import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const fallbackToken = requiredEnv("ZIQ_TELEGRAM_BOT_TOKEN");
const fallbackChatId = requiredEnv("ZIQ_TELEGRAM_CHAT_ID");

const token =
  process.env.ZIQ_TELEGRAM_CONTROL_BOT_TOKEN?.trim() || fallbackToken;
const chatId =
  process.env.ZIQ_TELEGRAM_CONTROL_CHAT_ID?.trim() || fallbackChatId;
const apiBase = (process.env.ZIQ_PHASE7C_CONTROL_API_URL?.trim() || "http://127.0.0.1:3711").replace(/\/$/, "");
const symbol = process.env.ZIQ_PHASE7C_REGIME_SYMBOL?.trim().toUpperCase() || "XAUUSD";
const candleCount = clampInt(process.env.ZIQ_PHASE7C_REGIME_CANDLE_COUNT, 320, 220, 1000);
const intervalMs = clampInt(process.env.ZIQ_PHASE7C_REGIME_INTERVAL_MS, 15_000, 5_000, 300_000);
const heartbeatMinutes = clampInt(process.env.ZIQ_PHASE7C_REGIME_HEARTBEAT_MINUTES, 60, 0, 1440);
const stateFile = resolve(
  process.env.ZIQ_PHASE7C_REGIME_STATE_FILE?.trim() || ".runtime/phase7c-regime-notifier-state.json",
);
const decisionJournalFile = resolve(
  process.env.ZIQ_PHASE7C_AUTO_JOURNAL_FILE?.trim() || join(dirname(stateFile), "auto-decisions.jsonl"),
);
const decisionStateFile = resolve(
  process.env.ZIQ_PHASE7C_AUTO_JOURNAL_STATE_FILE?.trim() || join(dirname(stateFile), "auto-journal-state.json"),
);
const telegramBase = `https://api.telegram.org/bot${token}`;

let state = await loadJsonState(stateFile);
let decisionState = await loadJsonState(decisionStateFile);
console.log("PHASE7C_REGIME_NOTIFIER=RUNNING");
console.log(`PHASE7C_REGIME_API=${apiBase}`);
console.log(`PHASE7C_REGIME_SYMBOL=${symbol}`);
console.log(`PHASE7C_REGIME_INTERVAL_MS=${intervalMs}`);
console.log(`PHASE7C_REGIME_HEARTBEAT_MINUTES=${heartbeatMinutes}`);
console.log(`PHASE7C_AUTO_JOURNAL_FILE=${decisionJournalFile}`);
console.log("PHASE7C_MT5_ORDER_PERMISSION=NONE");

while (true) {
  const startedAt = Date.now();
  try {
    const snapshot = await fetchRegime();

    const journalReasons = decisionJournalReasons(snapshot, decisionState);
    if (journalReasons.length > 0) {
      await appendDecisionJournal(snapshot, journalReasons, startedAt);
      decisionState = {
        regime: snapshot.regime,
        recommendedMode: snapshot.recommendedMode,
        activeMode: snapshot.activeMode,
        confidence: snapshot.confidence,
        lastCandleCloseTime: snapshot.lastCandleCloseTime,
        updatedAt: startedAt,
      };
      await saveJsonState(decisionStateFile, decisionState);
      console.log(
        `PHASE7C_AUTO_DECISION=${snapshot.regime}|RECOMMENDED=${snapshot.recommendedMode}|ACTIVE=${snapshot.activeMode}|CONFIDENCE=${snapshot.confidence}|REASONS=${journalReasons.join(",")}`,
      );
    }

    const reason = notificationReason(snapshot, state, startedAt);
    if (reason) {
      await sendTelegram(snapshot, reason);
      state = {
        regime: snapshot.regime,
        recommendedMode: snapshot.recommendedMode,
        activeMode: snapshot.activeMode,
        lastCandleCloseTime: snapshot.lastCandleCloseTime,
        lastNotifiedAt: startedAt,
      };
      await saveJsonState(stateFile, state);
      console.log(
        `PHASE7C_REGIME_NOTIFICATION=${snapshot.regime}|RECOMMENDED=${snapshot.recommendedMode}|ACTIVE=${snapshot.activeMode}|REASON=${reason}`,
      );
    } else {
      state = {
        ...state,
        regime: snapshot.regime,
        recommendedMode: snapshot.recommendedMode,
        activeMode: snapshot.activeMode,
        lastCandleCloseTime: snapshot.lastCandleCloseTime,
      };
      await saveJsonState(stateFile, state);
    }
  } catch (error) {
    console.error(`PHASE7C_REGIME_NOTIFIER_ERROR=${errorMessage(error)}`);
  }

  const elapsed = Date.now() - startedAt;
  await sleep(Math.max(1000, intervalMs - elapsed));
}

function decisionJournalReasons(snapshot, previous) {
  const reasons = [];
  if (!previous.regime) {
    reasons.push("INITIAL");
    return reasons;
  }
  if (snapshot.regime !== previous.regime) reasons.push("REGIME_CHANGED");
  if (snapshot.recommendedMode !== previous.recommendedMode) reasons.push("RECOMMENDATION_CHANGED");
  if (snapshot.activeMode !== previous.activeMode) reasons.push("ACTIVE_MODE_CHANGED");
  if (Number(snapshot.lastCandleCloseTime) !== Number(previous.lastCandleCloseTime)) reasons.push("M15_CLOSED");
  return reasons;
}

function notificationReason(snapshot, previous, now) {
  if (!previous.regime) return "INITIAL";
  if (snapshot.regime !== previous.regime) return "REGIME_CHANGED";
  if (snapshot.recommendedMode !== previous.recommendedMode) return "RECOMMENDATION_CHANGED";
  if (snapshot.activeMode !== previous.activeMode) return "ACTIVE_MODE_CHANGED";

  if (
    heartbeatMinutes > 0 &&
    previous.lastNotifiedAt &&
    now - previous.lastNotifiedAt >= heartbeatMinutes * 60_000 &&
    snapshot.lastCandleCloseTime !== previous.lastCandleCloseTime
  ) {
    return "HEARTBEAT";
  }

  return "";
}

async function appendDecisionJournal(snapshot, reasons, now) {
  await mkdir(dirname(decisionJournalFile), { recursive: true });
  const row = {
    timestamp: now,
    timestampIso: new Date(now).toISOString(),
    type: "AUTO_DECISION",
    symbol,
    activeMode: String(snapshot.activeMode),
    regime: String(snapshot.regime),
    recommendedMode: String(snapshot.recommendedMode),
    confidence: finiteNumber(snapshot.confidence),
    engineReasons: Array.isArray(snapshot.reasons) ? snapshot.reasons.map(String) : [],
    engineSource: "MarketRegimeClassifier",
    modeMatchesRecommendation: Boolean(snapshot.modeMatchesRecommendation),
    lastCandleCloseTime: finiteNumber(snapshot.lastCandleCloseTime),
    metrics: snapshot.metrics ?? null,
    supplyDemandRange: snapshot.supplyDemandRange ?? null,
    reasons,
    source: "REGIME_NOTIFIER",
  };
  await appendFile(decisionJournalFile, `${JSON.stringify(row)}\n`, "utf8");
}

async function fetchRegime() {
  const query = new URLSearchParams({
    symbol,
    count: String(candleCount),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${apiBase}/api/v1/phase7c/live-regime?${query.toString()}`, {
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Phase7C live-regime ${response.status}: ${text}`);
    }
    const snapshot = JSON.parse(text);
    if (!snapshot?.regime || !snapshot?.recommendedMode || !snapshot?.activeMode) {
      throw new Error("Phase7C live-regime returned an incomplete snapshot.");
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegram(snapshot, reason) {
  const response = await fetch(`${telegramBase}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatMessage(snapshot, reason),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram sendMessage failed: ${JSON.stringify(payload)}`);
  }
}

function formatMessage(snapshot, reason) {
  const regime = String(snapshot.regime);
  const recommended = String(snapshot.recommendedMode);
  const active = String(snapshot.activeMode);
  const confidence = percentage(snapshot.confidence);
  const currentPrice = number(snapshot.metrics?.close, 2);
  const atr = number(snapshot.metrics?.atr, 2);
  const adx = firstNumber(snapshot.metrics, ["adx", "adxValue", "trendStrength"]);
  const bandwidth = number(snapshot.metrics?.bollingerBandwidth, 4);
  const range = snapshot.supplyDemandRange;
  const icon = regimeIcon(regime);
  const modeStatus = snapshot.modeMatchesRecommendation
    ? "✅ Mode đang chạy phù hợp"
    : `⚠️ Mode đang chạy <b>${escapeHtml(active)}</b> khác khuyến nghị <b>${escapeHtml(recommended)}</b>`;

  const lines = [
    `${icon} <b>XAUUSD AI MASTER · MARKET REGIME</b>`,
    "",
    `Regime: <b>${escapeHtml(regimeLabel(regime))}</b>`,
    `Confidence: <b>${escapeHtml(confidence)}</b>`,
    `Khuyến nghị: <b>${escapeHtml(recommended)}</b>`,
    `Mode hiện tại: <b>${escapeHtml(active)}</b>`,
    modeStatus,
    "",
    `Giá M15: <b>${currentPrice}</b>`,
    `ATR: ${atr}`,
    `ADX: ${adx === null ? "n/a" : number(adx, 1)}`,
    `BB Width: ${bandwidth}`,
  ];

  if (range) {
    lines.push(
      "",
      "📦 <b>Supply / Demand Range</b>",
      `Supply: ${number(range.supply?.low, 2)} → ${number(range.supply?.high, 2)}`,
      `Demand: ${number(range.demand?.low, 2)} → ${number(range.demand?.high, 2)}`,
      `Range position: ${percentage(range.position)}`,
      `Range quality: ${percentage(range.quality)}`,
    );
  }

  lines.push(
    "",
    recommendationText(recommended),
    `Trigger: ${escapeHtml(reason)}`,
    "",
    "🎛 Đổi mode tại khung BOT MODE riêng bằng /mode hoặc /bots.",
  );

  return lines.join("\n");
}

function recommendationText(mode) {
  if (mode === "TREND") {
    return "🟢 <b>Đề xuất:</b> dùng Trend Bot; Sideway Bot nên tắt.";
  }
  if (mode === "SIDEWAY") {
    return "🟡 <b>Đề xuất:</b> dùng Sideway Bot tại biên Supply/Demand; Trend Bot nên tắt.";
  }
  return "⚪ <b>Đề xuất:</b> TRANSITION/UNCERTAIN — PAUSE cả hai bot, chờ xác nhận mới.";
}

function keyboard(activeMode) {
  const button = (label, mode) => ({
    text: `${activeMode === mode ? "✅ " : ""}${label}`,
    callback_data: `p7c:${mode}`,
  });
  return {
    inline_keyboard: [
      [button("TREND", "TREND"), button("SIDEWAY", "SIDEWAY")],
      [button("AUTO", "AUTO"), button("PAUSE", "PAUSE")],
    ],
  };
}

function regimeLabel(regime) {
  if (regime === "TRENDING") return "TREND";
  if (regime === "BREAKOUT") return "TREND / BREAKOUT";
  if (regime === "RANGING") return "SIDEWAY";
  if (regime === "REVERSAL") return "TRANSITION / REVERSAL";
  return "TRANSITION / UNCERTAIN";
}

function regimeIcon(regime) {
  if (regime === "TRENDING" || regime === "BREAKOUT") return "🟢";
  if (regime === "RANGING") return "🟡";
  return "⚪";
}

async function loadJsonState(file) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveJsonState(file, nextState) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = Number(object?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function percentage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  const normalized = numeric <= 1 ? numeric * 100 : numeric;
  return `${normalized.toFixed(0)}%`;
}

function number(value, digits) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "n/a";
}

function clampInt(raw, fallback, min, max) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
